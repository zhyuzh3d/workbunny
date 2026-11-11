#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import "BoperProtocol.h"
#import "BoperSecurity.h"
#include "BoperCore.hpp"
#include <atomic>
#include <condition_variable>
#include <fcntl.h>
#include <iostream>
#include <mutex>
#include <map>
#include <thread>
#include <unistd.h>

using namespace boper;
static std::mutex outputMutex;
// Set only by --self-test. No production command selects a test transport.
static void (^offlineReplySink)(NSDictionary *)=nil;
static void output(NSDictionary *value) {
  @autoreleasepool {
    if(offlineReplySink){std::lock_guard<std::mutex> lock(outputMutex);offlineReplySink(value);return;}
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    if (!data) return;
    std::lock_guard<std::mutex> lock(outputMutex);
    fwrite(data.bytes,1,data.length,stdout); fputc('\n',stdout); fflush(stdout);
  }
}
static NSString *str(id value) { return [value isKindOfClass:NSString.class] ? value : @""; }
static double number(id value, double fallback = NAN) { return [value isKindOfClass:NSNumber.class] ? [value doubleValue] : fallback; }
static std::string utf(NSString *s) { return s.UTF8String ?: ""; }
static NSDictionary *rpc(NSXPCConnection *connection, NSString *method, NSDictionary *request, unsigned timeoutMs = 600) {
  if (!connection) throw Failure("E_HELPER_DISCONNECTED", "HID helper is not connected");
  __block NSDictionary *response;
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  id<BoperInputProtocol> proxy = [connection remoteObjectProxyWithErrorHandler:^(NSError *) {
    response = BoperError(@"E_HELPER_DISCONNECTED", @"HID helper connection failed"); dispatch_semaphore_signal(semaphore);
  }];
  BoperReply reply = ^(NSDictionary *r) { response = r; dispatch_semaphore_signal(semaphore); };
  if ([method isEqual:@"open"]) [proxy open:request reply:reply];
  else if ([method isEqual:@"stop"]) [proxy stop:request reply:reply];
  else [proxy submit:request reply:reply];
  if (dispatch_semaphore_wait(semaphore,dispatch_time(DISPATCH_TIME_NOW,timeoutMs*NSEC_PER_MSEC)))
    throw Failure("E_HELPER_TIMEOUT", "HID helper did not reply within its bound; input outcome may be unknown");
  if (![response[@"ok"] boolValue]) throw Failure(utf(str(response[@"error"][@"code"])),utf(str(response[@"error"][@"message"])));
  return response[@"result"] ?: @{};
}

class Runtime {
  dispatch_queue_t worker = dispatch_queue_create("cn.haminn.workbunny.boper.worker", DISPATCH_QUEUE_SERIAL);
  std::atomic<bool> busy{false}, valid{false}, exiting{false},releaseFault{false};
  std::atomic<unsigned> cleaning{0};
  std::atomic<uint64_t> generation{0}, deadline{0};
  std::mutex stateMutex, waitMutex;
  std::condition_variable wake;
  NSString *session = @"", *backend = @"";
  NSArray *bounds = @[];
  NSXPCConnection *helper = nil;
  id (^helperFactory)(void)=nil;
  KeyboardState keyboard;
  PointerState pointer;
  uint64_t reportSeq = 0, lastReportNs = 0;
  uint64_t operationReports = 0;
  uint64_t operationAttempts = 0;
  bool dispatchOutcomeUnknown = false;
  bool clipboardChanged = false, moved = false;
  NSInteger clipboardCount = -1;
  pid_t targetPid = 0;
  double measuredPointerGain = 0;
  std::map<uint16_t,Key> heldKeys;
public:
  explicit Runtime(id (^factory)(void)=nil):helperFactory(factory) {
    // An in-memory fake is used exclusively by --self-test; no CG callbacks,
    // watchdog, NSXPCConnection, HID reports or clipboard access are created.
    if(factory)return;
    CGDisplayRegisterReconfigurationCallback([](CGDirectDisplayID,CGDisplayChangeSummaryFlags flags,void *context) {
      if (flags & ~kCGDisplayBeginConfigurationFlag) static_cast<Runtime *>(context)->invalidateAndRelease();
    },this);
    std::thread([this] {
      while (!exiting) {
        if (valid && BoperContinuousNs() >= deadline.load())invalidateAndRelease();
        std::unique_lock<std::mutex> lock(waitMutex); wake.wait_for(lock,std::chrono::milliseconds(30));
      }
    }).detach();
  }
  void drainForSelfTest(){dispatch_sync(worker, ^{});}
  void invalidate() { {std::lock_guard<std::mutex> lock(stateMutex);valid=false;++generation;}wake.notify_all(); }
  void invalidateAndRelease(NSXPCConnection *expected=nil){
    {std::lock_guard<std::mutex> lock(stateMutex);
      if(expected&&helper!=expected)return;
      ++cleaning;valid=false;++generation;
    }
    wake.notify_all();dispatch_async(worker, ^{@autoreleasepool{try{reset();}catch(...){releaseFault=true;}--cleaning;}});
  }
  void helperConnectionFailed(NSXPCConnection *expected){if(expected)invalidateAndRelease(expected);}
  void check(uint64_t g) {
    if (!valid || generation != g || BoperContinuousNs() >= deadline.load()) throw Failure("E_CANCELLED", "Input session stopped or expired");
  }
  void pace(uint64_t g) {
    check(g);
    uint64_t due = lastReportNs + reportIntervalMs * NSEC_PER_MSEC;
    uint64_t now=BoperContinuousNs();
    if (now < due) {
      std::unique_lock<std::mutex> lock(waitMutex);
      wake.wait_for(lock,std::chrono::nanoseconds(due - now),[&]{return !valid || generation != g;});
    }
    check(g);
    if (reportSeq >= maxReports) throw Failure("E_REPORT_LIMIT", "Input session report budget exhausted");
  }
  bool virtualHid() { return [backend isEqual:@"virtual-hid"]; }
  DesktopPoint cursor() {
    CGEventRef event = CGEventCreate(nullptr);
    if (!event) throw Failure("E_CURSOR_UNAVAILABLE", "Cannot obtain system pointer position");
    CGPoint p = CGEventGetLocation(event); CFRelease(event); return {p.x,p.y};
  }
  bool allowed(DesktopPoint p) {
    for (NSDictionary *r in bounds) if (DesktopRect{number(r[@"x"]),number(r[@"y"]),number(r[@"width"]),number(r[@"height"])}.contains(p)) return true;
    return false;
  }
  DesktopPoint position(NSDictionary *params, bool optional = false) {
    DesktopPoint p{number(params[@"x"]),number(params[@"y"])};
    if (optional && (!std::isfinite(p.x) || !std::isfinite(p.y))) p=cursor();
    if (!allowed(p)) throw Failure("E_COORDINATE_RANGE", "Coordinates are outside the current observed display region");
    return p;
  }
  void evidence(NSDictionary *params) {
    NSDictionary *e = [params[@"visualEvidence"] isKindOfClass:NSDictionary.class] ? params[@"visualEvidence"] : nil;
    if (!e) return; // Structured adapters have their own authorized scope.
    double captured = number(e[@"capturedAt"]);
    double age = NSDate.date.timeIntervalSince1970 * 1000 - captured;
    if (!std::isfinite(captured) || age < -100 || age > 1500) throw Failure("E_VISUAL_EVIDENCE_EXPIRED", "Visual evidence expired before committing input");
  }
  CGEventFlags flags() {
    CGEventFlags f=0; uint8_t m=keyboard.modifiers;
    if (m & 0x11) f|=kCGEventFlagMaskControl;
    if (m & 0x22) f|=kCGEventFlagMaskShift;
    if (m & 0x44) f|=kCGEventFlagMaskAlternate;
    if (m & 0x88) f|=kCGEventFlagMaskCommand;
    return f;
  }
  void post(CGEventRef e) {
    if (!e) throw Failure("E_CGEVENT_CREATE", "Cannot create input event");
    CGEventSetFlags(e,flags());
    if (targetPid) CGEventPostToPid(targetPid,e); else CGEventPost(kCGHIDEventTap,e);
    CFRelease(e);
  }
  void submitted() { ++reportSeq; ++operationReports; lastReportNs=BoperContinuousNs(); }
  void hid(NSDictionary *report, uint64_t g) {
    pace(g);
    NSMutableDictionary *r=[report mutableCopy]; r[@"inputSessionId"]=session; r[@"reportSeq"]=@(reportSeq+1);
    r[@"deadlineNs"]=@(BoperContinuousNs()+100*NSEC_PER_MSEC);
    ++operationAttempts;dispatchOutcomeUnknown=true;
    rpc(helper,@"submit",r);submitted();dispatchOutcomeUnknown=false;
  }
  void keyboardReport(Key changed, bool down, uint64_t g) {
    if (virtualHid()) {
      NSMutableArray *keys=[NSMutableArray array]; for (auto k:keyboard.keys) [keys addObject:@(k)];
      hid(@{@"kind":@"keyboard",@"modifiers":@(keyboard.modifiers),@"keys":keys},g);
    } else {
      pace(g); post(CGEventCreateKeyboardEvent(nullptr,changed.cgCode,down)); submitted();
    }
  }
  void changeKey(Key k, bool down, uint64_t g) {
    if (k.modifier) { if (down) keyboard.modifiers|=k.modifier; else keyboard.modifiers&=~k.modifier; }
    else { if (down) keyboard.keys.insert(k.usage); else keyboard.keys.erase(k.usage); }
    if (down) heldKeys[k.usage]=k; else heldKeys.erase(k.usage);
    keyboardReport(k,down,g);
  }
  void pointReport(int dx,int dy,int vertical,int horizontal,CGPoint at,CGEventType eventType, uint8_t buttonMask,uint64_t g, int clickCount=1) {
    if (virtualHid()) hid(@{@"kind":@"pointing",@"dx":@(dx),@"dy":@(dy),@"verticalWheel":@(vertical),@"horizontalWheel":@(horizontal),@"buttons":@(pointer.buttons)},g);
    else {
      pace(g);
      CGMouseButton b=buttonMask==2?kCGMouseButtonRight:buttonMask==4?kCGMouseButtonCenter:kCGMouseButtonLeft;
      CGEventRef event;
      if (vertical || horizontal) event=CGEventCreateScrollWheelEvent(nullptr,kCGScrollEventUnitPixel,2,vertical,horizontal);
      else event=CGEventCreateMouseEvent(nullptr,eventType,at,b);
      if (event && eventType!=kCGEventMouseMoved) CGEventSetIntegerValueField(event,kCGMouseEventClickState,clickCount);
      post(event); submitted();
    }
  }
  CGEventType moveType() { return pointer.buttons&1?kCGEventLeftMouseDragged:pointer.buttons&2?kCGEventRightMouseDragged:pointer.buttons&4?kCGEventOtherMouseDragged:kCGEventMouseMoved; }
  void pause(unsigned ms,uint64_t g) {
    std::unique_lock<std::mutex> lock(waitMutex);wake.wait_for(lock,std::chrono::milliseconds(ms),[&]{return !valid||generation!=g;});lock.unlock();check(g);
  }
  void moveTo(DesktopPoint target, uint64_t g, unsigned durationOverride=0) {
    if (!allowed(target)) throw Failure("E_COORDINATE_RANGE", "Target is outside the observed display region");
    DesktopPoint from=cursor(), previous=from;
    uint64_t start=BoperContinuousNs(); unsigned duration=durationOverride?:movementDuration(from,target);
    unsigned corrections=0; double residualX=0,residualY=0;
    while (true) {
      check(g); double t=(BoperContinuousNs()-start)/(duration*1e6);
      DesktopPoint desired=trajectory(from,target,t), actual=cursor();
      if (std::hypot(actual.x-previous.x,actual.y-previous.y)>180 && std::hypot(target.x-actual.x,target.y-actual.y)>20)
        throw Failure("E_POINTER_INTERFERENCE", "Pointer moved outside the bounded trajectory");
      if (virtualHid()) {
        double ex=desired.x-actual.x,ey=desired.y-actual.y;
        if (t>=1 && std::hypot(ex,ey)<=1.5) break;
        if (t>=1 && ++corrections>45) throw Failure("E_POINTER_NOT_CONVERGED", "Virtual pointer did not converge within its correction budget");
        // One pulse followed by a settle interval avoids learning from or
        // correcting against reports that are still in the driver pipeline.
        // The first tiny pulse measures this session's actual relative gain.
        double gain=measuredPointerGain>0?measuredPointerGain:1.;
        double cap=measuredPointerGain>0?(std::hypot(ex,ey)>30?24.:6.):2.;
        double rx=std::clamp(ex/gain*.7,-cap,cap)+residualX,ry=std::clamp(ey/gain*.7,-cap,cap)+residualY;
        int dx=std::clamp((int)std::round(rx),-(int)cap,(int)cap),dy=std::clamp((int)std::round(ry),-(int)cap,(int)cap);
        residualX=rx-dx;residualY=ry-dy;
        if (dx||dy) {
          pointReport(dx,dy,0,0,CGPointMake(actual.x,actual.y),moveType(),1,g);moved=true;
          // Require two stable position samples after at least 24ms. This is
          // bounded; delayed or externally disturbed feedback is discarded.
          pause(24,g);DesktopPoint settled=cursor();unsigned stable=0;
          for(unsigned wait=0;wait<8&&stable<2;++wait){pause(8,g);DesktopPoint next=cursor();stable=std::hypot(next.x-settled.x,next.y-settled.y)<.1?stable+1:0;settled=next;}
          double raw=std::hypot(dx,dy),ox=settled.x-actual.x,oy=settled.y-actual.y;
          double projection=(ox*dx+oy*dy)/raw,perpendicular=std::abs(ox*dy-oy*dx)/raw;
          double sample=projection/raw;
          if(stable>=2&&allowed(settled)&&sample>=.05&&sample<=12&&perpendicular<std::max(1.,projection*.2))
            measuredPointerGain=measuredPointerGain>0?measuredPointerGain*.7+sample*.3:sample;
          previous=settled;
          if(!allowed(settled))throw Failure("E_POINTER_INTERFERENCE", "Pointer left the observed display region");
          if(BoperContinuousNs()-start>4*NSEC_PER_SEC)throw Failure("E_POINTER_NOT_CONVERGED", "Virtual pointer exceeded the movement time bound");
          continue;
        }
      } else {
        pointReport(0,0,0,0,CGPointMake(desired.x,desired.y),moveType(),1,g); moved=true;
        if(t>=1) break;
      }
      previous=cursor();
      std::unique_lock<std::mutex> lock(waitMutex); wake.wait_for(lock,std::chrono::milliseconds(reportIntervalMs),[&]{return !valid || generation!=g;});
    }
  }
  void mouseButton(uint8_t b,bool down,DesktopPoint p,uint64_t g,int count=1) {
    if(down) pointer.buttons|=b; else pointer.buttons&=~b;
    CGEventType type=b==1?(down?kCGEventLeftMouseDown:kCGEventLeftMouseUp):b==2?(down?kCGEventRightMouseDown:kCGEventRightMouseUp):(down?kCGEventOtherMouseDown:kCGEventOtherMouseUp);
    pointReport(0,0,0,0,CGPointMake(p.x,p.y),type,b,g,count);
  }
  void tap(Key k, NSArray *modifiers, uint64_t g) {
    std::vector<Key> added;
    for(id name in modifiers) { Key m=key(utf(str(name))); if(!m.modifier) throw Failure("E_MODIFIER", "Invalid modifier"); if(!(keyboard.modifiers&m.modifier)) {changeKey(m,true,g);added.push_back(m);} }
    if(heldKeys.count(k.usage)) throw Failure("E_KEY_HELD", "Cannot tap an already held key");
    changeKey(k,true,g);changeKey(k,false,g);
    for(auto it=added.rbegin();it!=added.rend();++it) changeKey(*it,false,g);
  }
  void reset() {
    if (virtualHid()) {
      if (helper) rpc(helper,@"stop",@{@"inputSessionId":session});
    } else {
      for(auto &entry:heldKeys) { Key k=entry.second; if(k.modifier) keyboard.modifiers&=~k.modifier; post(CGEventCreateKeyboardEvent(nullptr,k.cgCode,false)); }
      if(pointer.buttons) { DesktopPoint p=cursor(); for(uint8_t b:{1,2,4}) if(pointer.buttons&b) { CGEventType t=b==1?kCGEventLeftMouseUp:b==2?kCGEventRightMouseUp:kCGEventOtherMouseUp;post(CGEventCreateMouseEvent(nullptr,t,CGPointMake(p.x,p.y),b==1?kCGMouseButtonLeft:b==2?kCGMouseButtonRight:kCGMouseButtonCenter)); } }
    }
    heldKeys.clear();keyboard={};pointer={};
  }
  NSDictionary *effects(NSString *operationId) {
    NSMutableDictionary *r=[@{@"backend":backend,@"inputSessionId":session,@"operationId":operationId?:@"",@"reportsSubmitted":@(operationReports),@"reportsAttempted":@(operationAttempts),@"dispatchOutcomeUnknown":@(dispatchOutcomeUnknown),@"clipboardChanged":@(clipboardChanged),@"dispatched":@(operationReports>0||operationAttempts>0),@"moved":@(moved),@"completion":dispatchOutcomeUnknown?@"unknown":@"local-submitted",@"targetVerified":@NO} mutableCopy];
    if(clipboardCount>=0) r[@"clipboardChangeCount"]=@(clipboardCount);
    return r;
  }
  void execute(NSDictionary *request) {
    NSString *opId=str(request[@"operationId"]); NSDictionary *operation=[request[@"operation"]isKindOfClass:NSDictionary.class]?request[@"operation"]:@{};
    NSDictionary *p=[operation[@"params"] isKindOfClass:NSDictionary.class]?operation[@"params"]:@{};
    NSString *action=str(operation[@"action"]);
    uint64_t g=generation.load();operationReports=0;operationAttempts=0;dispatchOutcomeUnknown=false;clipboardChanged=false;moved=false;clipboardCount=-1;targetPid=0;
    try {
      check(g);
      if(![str(request[@"inputSessionId"]) isEqual:session]) throw Failure("E_SESSION_MISMATCH", "Operation belongs to another input session");
      if(opId.length==0||opId.length>160) throw Failure("E_OPERATION_ID", "operationId is required and bounded");
      targetPid=(pid_t)number(p[@"targetPid"],0);
      if(targetPid && virtualHid()) throw Failure("E_BACKGROUND_UNSUPPORTED", "VirtualHID does not support targeted PID input");
      if(targetPid && (![action isEqual:@"key"]||!heldKeys.empty())) throw Failure("E_BACKGROUND_UNSUPPORTED", "This directed input requires an explicitly supported foreground input flow");
      if([action isEqual:@"move"]) moveTo(position(p),g);
      else if([action isEqual:@"click"]||[action isEqual:@"mouseDown"]||[action isEqual:@"mouseUp"]) {
        DesktopPoint at=position(p,true); uint8_t b=button(utf(str(p[@"button"])));
        if(![action isEqual:@"mouseUp"]) {moveTo(at,g);evidence(p);}
        if([action isEqual:@"click"]) {
          int count=(int)number(p[@"clickCount"],1);if(count<1||count>3) throw Failure("E_CLICK_COUNT", "clickCount must be 1..3");
          for(int i=1;i<=count;++i){evidence(p);mouseButton(b,true,at,g,i);mouseButton(b,false,at,g,i);}
        } else mouseButton(b,[action isEqual:@"mouseDown"],at,g);
      } else if([action isEqual:@"drag"]) {
        DesktopPoint from{number(p[@"fromX"],number(p[@"startX"])),number(p[@"fromY"],number(p[@"startY"]))};
        DesktopPoint to{number(p[@"toX"],number(p[@"endX"],number(p[@"x"]))),number(p[@"toY"],number(p[@"endY"],number(p[@"y"])))};
        if(!allowed(from)||!allowed(to))throw Failure("E_COORDINATE_RANGE", "Drag endpoints must be inside the observed display region");
        uint8_t b=button(utf(str(p[@"button"])));moveTo(from,g);evidence(p);mouseButton(b,true,from,g);moveTo(to,g);mouseButton(b,false,to,g);
      } else if([action isEqual:@"key"]||[action isEqual:@"keyDown"]||[action isEqual:@"keyUp"]) {
        Key k=key(utf(str(p[@"key"])));if(![action isEqual:@"keyUp"])evidence(p);
        if(p[@"clipboardChangeCount"]){clipboardChanged=[p[@"clipboardChanged"]boolValue];clipboardCount=[p[@"clipboardChangeCount"]integerValue];if(NSPasteboard.generalPasteboard.changeCount!=clipboardCount)throw Failure("E_CLIPBOARD_REPLACED", "Prepared clipboard changed before the paste shortcut");}
        NSArray *mods=[p[@"modifiers"] isKindOfClass:NSArray.class]?p[@"modifiers"]:@[];
        if([action isEqual:@"key"])tap(k,mods,g);else changeKey(k,[action isEqual:@"keyDown"],g);
        if(p[@"clipboardChangeCount"]&&NSPasteboard.generalPasteboard.changeCount!=clipboardCount)throw Failure("E_PASTE_OUTCOME_UNKNOWN", "Clipboard changed while the paste shortcut was being submitted");
      } else if([action isEqual:@"scroll"]) {
        if(p[@"x"]&&p[@"y"])moveTo(position(p),g);evidence(p);
        double dx=number(p[@"deltaX"],0),dy=number(p[@"deltaY"],0);
        if(!std::isfinite(dx)||!std::isfinite(dy)||fabs(dx)>10000||fabs(dy)>10000)throw Failure("E_SCROLL_RANGE", "Scroll amount is out of range");
        int x=(int)std::round(dx),y=(int)std::round(dy);DesktopPoint at=cursor();
        while(x||y){int sx=std::clamp(x,-20,20),sy=std::clamp(y,-20,20);pointReport(0,0,sy,sx,CGPointMake(at.x,at.y),kCGEventMouseMoved,1,g);x-=sx;y-=sy;}
      } else if([action isEqual:@"typeText"]) {
        NSString *text=str(p[@"text"]);
        if(text.length>131072)throw Failure("E_TEXT_LIMIT", "Text exceeds the bounded clipboard preparation size");
        if(!text.length)throw Failure("E_EMPTY_TEXT", "Text must not be empty");
        evidence(p);check(g);
        NSPasteboard *pb=NSPasteboard.generalPasteboard;
        [pb clearContents];clipboardChanged=true;
        if(![pb setString:text forType:NSPasteboardTypeString])throw Failure("E_CLIPBOARD_WRITE", "Clipboard write failed; no paste shortcut was sent");
        clipboardCount=pb.changeCount;
        evidence(p);check(g);
        if(pb.changeCount!=clipboardCount)throw Failure("E_CLIPBOARD_REPLACED", "Clipboard was replaced before paste; shortcut was not sent");
        tap(key("v"),@[@"command"],g);
        if(pb.changeCount!=clipboardCount)throw Failure("E_PASTE_OUTCOME_UNKNOWN", "Clipboard changed while the paste shortcut was being submitted");
      } else throw Failure("E_UNSUPPORTED_OPERATION", "Unsupported BOPER operation");
      output(@{@"id":request[@"id"]?:NSNull.null,@"ok":@YES,@"result":effects(opId)});
    } catch(const Failure &e) {
      invalidate();bool released=false;try{reset();released=true;}catch(...){releaseFault=true;}
      NSMutableDictionary *r=[effects(opId) mutableCopy];r[@"releaseConfirmed"]=@(released);r[@"releaseLevel"]=@"local-submitted";
      output(@{@"id":request[@"id"]?:NSNull.null,@"ok":@NO,@"error":@{@"code":@(e.code.c_str()),@"message":@(e.what())},@"result":r});
    } catch(...) {
      invalidate();try{reset();}catch(...){releaseFault=true;}
      output(@{@"id":request[@"id"]?:NSNull.null,@"ok":@NO,@"error":@{@"code":@"E_NATIVE_FAILURE",@"message":@"Native input failed"},@"result":effects(opId)});
    }
    targetPid=0;busy=false;
  }
  void command(NSDictionary *request,bool control=false) {
    id reqId=request[@"id"]?:NSNull.null;NSString *action=str(request[@"action"]);
    try {
      if([action isEqual:@"status"]) {
        output(@{@"id":reqId,@"ok":@YES,@"result":@{@"protocolVersion":@(protocolVersion),@"architecture":@"arm64",@"inputSessionId":session,@"backend":backend,@"sessionActive":@(valid.load()),@"busy":@(busy.load()),@"cgEventGranted":@(helperFactory?false:CGPreflightPostEventAccess()),@"capabilities":@{@"globalInput":@YES,@"targetedText":@NO,@"unicodeClipboardPaste":@YES,@"automaticPhysicalTakeover":@NO}}});return;
      }
      if([action isEqual:@"renewSession"]) {
        unsigned ms=lease((unsigned)number(request[@"leaseMs"],1500));
        {std::lock_guard<std::mutex> lock(stateMutex);
          if(!valid||BoperContinuousNs()>=deadline.load()||![str(request[@"inputSessionId"]) isEqual:session])throw Failure("E_SESSION_MISMATCH", "Cannot renew inactive or expired input session");
          deadline=BoperContinuousNs()+ms*NSEC_PER_MSEC;
        }
        output(@{@"id":reqId,@"ok":@YES,@"result":@{@"leaseMs":@(ms)}});return;
      }
      if([action isEqual:@"stop"]||[action isEqual:@"closeSession"]) {
        NSString *stoppedSession;
        {std::lock_guard<std::mutex> lock(stateMutex);
          if(request[@"inputSessionId"]&&![str(request[@"inputSessionId"]) isEqual:session])throw Failure("E_SESSION_MISMATCH", "Stop belongs to another input session");
          stoppedSession=session;++cleaning;valid=false;++generation;
        }
        wake.notify_all();dispatch_async(worker, ^{ @autoreleasepool {
          try{reset();--cleaning;output(@{@"id":reqId,@"ok":@YES,@"result":@{@"releaseConfirmed":@YES,@"releaseLevel":@"local-submitted",@"inputSessionId":stoppedSession}});}
          catch(const Failure &e){releaseFault=true;--cleaning;output(@{@"id":reqId,@"ok":@NO,@"error":@{@"code":@(e.code.c_str()),@"message":@(e.what())},@"result":@{@"releaseConfirmed":@NO,@"inputSessionId":stoppedSession}});}
        }});return;
      }
      if(control)throw Failure("E_CONTROL_ACTION", "Control pipe permits only status, renewal and stop");
      if([action isEqual:@"execute"]) {
        bool expected=false;if(!busy.compare_exchange_strong(expected,true))throw Failure("E_BUSY", "Only one input Operation is accepted; no backlog is queued");
        dispatch_async(worker, ^{ @autoreleasepool {execute(request);} });return;
      }
      if([action isEqual:@"beginSession"]) {
        uint64_t openingGeneration;
        NSString *sid=str(request[@"inputSessionId"]),*kind=str(request[@"backend"]);
        if(sid.length<8||sid.length>160)throw Failure("E_SESSION_ID", "inputSessionId must contain 8..160 characters");
        if(![kind isEqual:@"cg-event"]&&![kind isEqual:@"virtual-hid"])throw Failure("E_BACKEND", "An explicit supported input backend is required");
        unsigned ms=lease((unsigned)number(request[@"leaseMs"],1500));
        NSArray *rects=[request[@"displayBounds"] isKindOfClass:NSArray.class]?request[@"displayBounds"]:@[];
        if(!rects.count||rects.count>16)throw Failure("E_DISPLAY_BOUNDS", "Observed displayBounds are required");
        for(NSDictionary *r in rects)if(![r isKindOfClass:NSDictionary.class]||!std::isfinite(number(r[@"x"]))||!std::isfinite(number(r[@"y"]))||number(r[@"width"],0)<=0||number(r[@"height"],0)<=0)throw Failure("E_DISPLAY_BOUNDS", "Invalid observed display bounds");
        if([kind isEqual:@"cg-event"]&&!CGPreflightPostEventAccess())throw Failure("E_INPUT_PERMISSION", "CGEvent permission is not granted");
        NSXPCConnection *retired;
        {std::lock_guard<std::mutex> lock(stateMutex);
          if(busy||valid||cleaning.load())throw Failure("E_BUSY", "Close and release the old input session before beginning another");
          if(releaseFault)throw Failure("E_RELEASE_UNKNOWN", "A previous input state could not be released; reconnect the executor before new input");
          // Retire identity before invalidating: invalidate may run its handler
          // immediately. That old handler must never cancel this opening.
          retired=helper;helper=nil;openingGeneration=++generation;
          session=sid;backend=kind;bounds=rects;reportSeq=0;keyboard={};pointer={};heldKeys.clear();measuredPointerGain=0;
        }
        retired.interruptionHandler=nil;retired.invalidationHandler=nil;[retired invalidate];
        if(virtualHid()) {
          NSXPCConnection *next=helperFactory?(NSXPCConnection *)helperFactory():[[NSXPCConnection alloc]initWithMachServiceName:BoperInputService options:NSXPCConnectionPrivileged];
          [next setCodeSigningRequirement:@BOPER_HELPER_REQUIREMENT];next.remoteObjectInterface=BoperInterface(@protocol(BoperInputProtocol));
          __weak NSXPCConnection *currentHelper=next;
          next.interruptionHandler=^{helperConnectionFailed(currentHelper);};next.invalidationHandler=^{helperConnectionFailed(currentHelper);};
          {std::lock_guard<std::mutex> lock(stateMutex);
            if(generation!=openingGeneration||cleaning.load())throw Failure("E_CANCELLED", "Input session opening was cancelled before activation");
            helper=next;
          }
          [next resume];rpc(next,@"open",@{@"inputSessionId":sid,@"delegationToken":str(request[@"delegationToken"])});
        }
        {std::lock_guard<std::mutex> lock(stateMutex);
          if(generation!=openingGeneration||cleaning.load())throw Failure("E_CANCELLED", "Input session opening was cancelled before activation");
          ++generation;deadline=BoperContinuousNs()+ms*NSEC_PER_MSEC;valid=true;
        }
        output(@{@"id":reqId,@"ok":@YES,@"result":@{@"inputSessionId":session,@"backend":backend,@"leaseMs":@(ms),@"protocolVersion":@(protocolVersion)}});return;
      }
      throw Failure("E_ACTION", "Unknown BOPER request action");
    } catch(const Failure &e){output(@{@"id":reqId,@"ok":@NO,@"error":@{@"code":@(e.code.c_str()),@"message":@(e.what())}});}
  }
  void eof(){invalidate();dispatch_sync(worker, ^{try{reset();}catch(...){} });}
};

static void readLines(int fd,Runtime *runtime,bool control) {
  std::string line; char buf[4096];ssize_t size;
  while((size=read(fd,buf,sizeof(buf)))>0) {
    for(ssize_t i=0;i<size;++i){if(buf[i]=='\n') {
      @autoreleasepool {NSData *data=[NSData dataWithBytes:line.data() length:line.size()];id value=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if([value isKindOfClass:NSDictionary.class])runtime->command(value,control);else output(@{@"id":NSNull.null,@"ok":@NO,@"error":@{@"code":@"E_JSON",@"message":@"Expected a JSON object"}});
      }line.clear();
    }else{line.push_back(buf[i]);if(line.size()>262144){runtime->eof();return;}}}
  }
  runtime->eof();
}

@interface BoperOfflineHelper:NSObject<BoperInputProtocol>
@property(copy) void (^interruptionHandler)(void);
@property(copy) void (^invalidationHandler)(void);
@property(copy) void (^onOpen)(void);
@property NSXPCInterface *remoteObjectInterface;
@property NSUInteger reports;
@end
@implementation BoperOfflineHelper
- (void)setCodeSigningRequirement:(NSString *)requirement{}
- (void)resume{}
- (void)invalidate{if(_invalidationHandler)_invalidationHandler();}
- (id)remoteObjectProxyWithErrorHandler:(void (^)(NSError *))handler{return self;}
- (void)open:(NSDictionary *)request reply:(BoperReply)reply{if(_onOpen)_onOpen();reply(@{@"ok":@YES,@"result":@{}});}
- (void)stop:(NSDictionary *)request reply:(BoperReply)reply{reply(@{@"ok":@YES,@"result":@{}});}
- (void)submit:(NSDictionary *)request reply:(BoperReply)reply{++_reports;reply(@{@"ok":@YES,@"result":@{}});}
@end

static int sessionLifecycleSelfTest(){
  NSMutableArray *responses=[NSMutableArray array],*connections=[NSMutableArray array];
  offlineReplySink=^(NSDictionary *reply){[responses addObject:reply];};
  Runtime *runtime=new Runtime(^id{BoperOfflineHelper *c=[BoperOfflineHelper new];[connections addObject:c];return c;});
  auto response=[&](NSNumber *requestId)->NSDictionary *{std::lock_guard<std::mutex> lock(outputMutex);for(NSDictionary *r in responses)if([r[@"id"]isEqual:requestId])return r;return nil;};
  auto begin=[&](int requestId,NSString *sessionId){runtime->command(@{@"id":@(requestId),@"action":@"beginSession",@"inputSessionId":sessionId,@"backend":@"virtual-hid",@"leaseMs":@1500,@"displayBounds":@[@{@"x":@0,@"y":@0,@"width":@2,@"height":@2}],@"delegationToken":@"offline-only"});};
  auto finish=[&](int code){runtime->drainForSelfTest();for(BoperOfflineHelper *c in connections)if(c.reports!=0)code=99;offlineReplySink=nil;return code;};
  begin(1,@"offline-session-a");if(![response(@1)[@"ok"]boolValue])return finish(10);
  BoperOfflineHelper *old=connections.lastObject;
  void (^lateInvalidation)(void)=[old.invalidationHandler copy];
  runtime->command(@{@"id":@21,@"action":@"execute",@"inputSessionId":@"offline-session-a",@"operationId":@"offline-stale-key",@"operation":@{@"action":@"key",@"params":@{@"key":@"v",@"visualEvidence":@{@"capturedAt":@0}}}});runtime->drainForSelfTest();
  if(![response(@21)[@"error"][@"code"]isEqual:@"E_VISUAL_EVIDENCE_EXPIRED"]||[response(@21)[@"result"][@"dispatched"]boolValue])return finish(17);
  runtime->command(@{@"id":@2,@"action":@"stop",@"inputSessionId":@"offline-session-a"},true);runtime->drainForSelfTest();
  begin(3,@"offline-session-b");runtime->drainForSelfTest();
  if(![response(@3)[@"ok"]boolValue])return finish(11);
  if(lateInvalidation)lateInvalidation();runtime->drainForSelfTest();
  runtime->command(@{@"id":@4,@"action":@"status"});
  if(![response(@4)[@"result"][@"sessionActive"]boolValue])return finish(12);
  // An old close/renew is rejected without cancelling the new session.
  runtime->command(@{@"id":@5,@"action":@"closeSession",@"inputSessionId":@"offline-session-a"},true);
  if([response(@5)[@"ok"]boolValue])return finish(13);
  runtime->command(@{@"id":@22,@"action":@"renewSession",@"inputSessionId":@"offline-session-a",@"leaseMs":@1500},true);
  if([response(@22)[@"ok"]boolValue])return finish(18);
  runtime->command(@{@"id":@6,@"action":@"status"});if(![response(@6)[@"result"][@"sessionActive"]boolValue])return finish(14);
  runtime->command(@{@"id":@7,@"action":@"stop",@"inputSessionId":@"offline-session-b"},true);runtime->drainForSelfTest();
  // A real matching stop during open must still prevent activation.
  // Install the stop hook through a separate fake factory, never a system port.
  __block Runtime *cancelled=nullptr;
  cancelled=new Runtime(^id{BoperOfflineHelper *c=[BoperOfflineHelper new];c.onOpen=^{cancelled->command(@{@"id":@9,@"action":@"stop",@"inputSessionId":@"offline-session-c"},true);};[connections addObject:c];return c;});
  cancelled->command(@{@"id":@8,@"action":@"beginSession",@"inputSessionId":@"offline-session-c",@"backend":@"virtual-hid",@"leaseMs":@1500,@"displayBounds":@[@{@"x":@0,@"y":@0,@"width":@2,@"height":@2}],@"delegationToken":@"offline-only"});cancelled->drainForSelfTest();
  if([response(@8)[@"ok"]boolValue]||![response(@8)[@"error"][@"code"]isEqual:@"E_CANCELLED"])return finish(15);
  cancelled->command(@{@"id":@10,@"action":@"status"});if([response(@10)[@"result"][@"sessionActive"]boolValue])return finish(16);
  return finish(0);
}
int main(int argc,char **argv) {
  @autoreleasepool {
    if(argc==2 && std::string(argv[1])=="--self-test") {
      if(key("escape").usage!=41||key("escape").cgCode!=53)return 1;
      for(double t=0;t<=1;t+=.001){auto p=trajectory({0,0},{100,50},t);if(p.x<0||p.x>100||p.y<0||p.y>50)return 2;}
      int lifecycle=sessionLifecycleSelfTest();if(lifecycle){output(@{@"ok":@NO,@"selfTest":@"offline-session-lifecycle",@"case":@(lifecycle),@"inputDispatched":@NO});return lifecycle;}
      output(@{@"ok":@YES,@"selfTest":@"protocol-key-map-trajectory-and-offline-session-lifecycle",@"inputDispatched":@NO});return 0;
    }
    // Never accept an interactive CLI or public socket as an input authority.
    if(isatty(STDIN_FILENO)){fputs("BOPER requires private inherited pipes\n",stderr);return 64;}
    signal(SIGPIPE,SIG_IGN);
    Runtime *runtime=new Runtime();
    if(fcntl(3,F_GETFD)!=-1)std::thread([runtime]{readLines(3,runtime,true);}).detach();
    std::thread([runtime]{readLines(0,runtime,false);_Exit(0);}).detach();
    CFRunLoopRun();
  }
}
