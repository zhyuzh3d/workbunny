#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <SystemConfiguration/SystemConfiguration.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#import <IOKit/IOMessage.h>
#import "BoperProtocol.h"
#import "BoperSecurity.h"
#include "BoperCore.hpp"
#include <pqrs/karabiner/driverkit/virtual_hid_device_service.hpp>
#include <pqrs/osx/autorelease_pool.hpp>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <unistd.h>

namespace svc=pqrs::karabiner::driverkit::virtual_hid_device_service;
namespace rep=pqrs::karabiner::driverkit::virtual_hid_device_driver::hid_report;
using namespace boper;
static NSString *s(id value){return [value isKindOfClass:NSString.class]?value:@"";}
static bool boundedString(id value,NSUInteger minimum,NSUInteger maximum){return [value isKindOfClass:NSString.class]&&[value length]>=minimum&&[value length]<=maximum;}
static bool integer(id value,int low,int high){return [value isKindOfClass:NSNumber.class]&&std::isfinite([value doubleValue])&&[value doubleValue]==[value longLongValue]&&[value longLongValue]>=low&&[value longLongValue]<=high;}

static bool consoleSession(uid_t uid,au_asid_t asid){
  uid_t consoleUid=0;gid_t gid=0;CFStringRef user=SCDynamicStoreCopyConsoleUser(nullptr,&consoleUid,&gid);
  if(user)CFRelease(user);if(consoleUid!=uid||uid==0)return false;
  io_registry_entry_t root=IORegistryGetRootEntry(kIOMainPortDefault);
  CFTypeRef raw=IORegistryEntryCreateCFProperty(root,CFSTR("IOConsoleUsers"),kCFAllocatorDefault,0);IOObjectRelease(root);
  if(!raw)return false;
  id users=CFBridgingRelease(raw);if(![users isKindOfClass:NSArray.class])return false;
  for(NSDictionary *entry in users){
    if([entry[@"kCGSSessionOnConsoleKey"] boolValue]&&[entry[@"kCGSSessionUserIDKey"] unsignedIntValue]==uid&&[entry[@"kCGSSessionAuditIDKey"] intValue]==asid)
      return [entry[@"kCGSessionLoginDoneKey"] boolValue]&&![entry[@"CGSSessionScreenIsLocked"] boolValue];
  }
  return false;
}

class Engine {
  std::unique_ptr<svc::client> client;
  std::mutex mutex;
  NSHashTable *closedPeers=[NSHashTable weakObjectsHashTable];
  NSMutableSet *hostConnections=[NSMutableSet set];
  IdleExitGate idleExit;
  NSXPCConnection *worker=nil;
  NSString *groupKey=@"",*session=@"",*token=@"";
  pid_t workerPid=0;std::atomic<uid_t> uid{0};std::atomic<au_asid_t> asid{0};
  bool transition=false;
  bool stopReleasing=false;
  NSMutableArray *stopReplies=[NSMutableArray array];
  std::atomic<bool> releaseConfirmed{false};
  std::atomic<bool> valid{false},connected{false},keyboardReady{false},pointingReady{false},mismatch{false},fault{false};
  std::atomic<uint64_t> expires{0},epoch{0};
  std::atomic<unsigned> pendingReleases{0};
  std::atomic<bool> consoleAllowed{false};
  std::atomic<uint64_t> exitDeadline{0};
  uint64_t lastSeq=0,lastNs=0;
  dispatch_queue_t outputQueue=dispatch_queue_create("cn.haminn.workbunny.boper.hid-output",DISPATCH_QUEUE_SERIAL);
public:
  Engine(){
    pqrs::dispatcher::extra::initialize_shared_dispatcher(pqrs::osx::autorelease_pool::execute_with_autorelease_pool);
    client=std::make_unique<svc::client>();
    client->connected.connect([this]{connected=true;client->async_virtual_hid_pointing_initialize();client->async_virtual_hid_keyboard_initialize(svc::virtual_hid_keyboard_parameters(pqrs::hid::vendor_id::value_t(0),pqrs::hid::product_id::value_t(0),pqrs::hid::country_code::value_t(0)));});
    client->closed.connect([this]{connected=false;keyboardReady=false;pointingReady=false;invalidate();});
    client->connect_failed.connect([this](auto&&){connected=false;});
    client->error_occurred.connect([this](auto&&){fault=true;invalidate();});
    client->driver_version_mismatched.connect([this](bool value){mismatch=value;if(value)invalidate();});
    client->virtual_hid_keyboard_ready.connect([this](bool value){keyboardReady=value;if(!value)invalidate();});
    client->virtual_hid_pointing_ready.connect([this](bool value){pointingReady=value;if(!value)invalidate();});
    client->async_start();
    std::thread([this]{while(true){@autoreleasepool{
      uint64_t now=BoperContinuousNs();
      if(valid){consoleAllowed=consoleSession(uid.load(),asid.load());if(now>=expires.load()||!consoleAllowed)invalidate();}
      bool finish=false;
      {std::lock_guard<std::mutex> lock(mutex);finish=idleExit.begin(now,valid.load(),transition||pendingReleases.load());if(finish){++epoch;token=@"";exitDeadline=now+1500*NSEC_PER_MSEC;}}
      if(finish)dispatch_async(outputQueue, ^{@autoreleasepool{
        // Only our client-local state is released. An unresponsive output path
        // is bounded by the independent exit deadline; closing this client's
        // connection lets the shared daemon destroy only these own devices.
        reset();client->async_stop();client->enqueue_to_dispatcher([]{_Exit(0);});
      }});
      if(exitDeadline.load()&&now>=exitDeadline.load())_Exit(0);
    }std::this_thread::sleep_for(std::chrono::milliseconds(40));}}).detach();
  }
  bool transportReady(){return connected&&keyboardReady&&pointingReady&&!mismatch;}
  bool ready(){return transportReady()&&!fault;}
  void invalidate(){
    // Reserve the release before relinquishing authority: a new group cannot
    // start while an old group's queued zero reports can still arrive.
    ++pendingReleases;bool had=valid.exchange(false);++epoch;if(had)releaseConfirmed=false;
    if(had)dispatch_async(outputQueue, ^{ @autoreleasepool {reset();--pendingReleases;} });
    else --pendingReleases;
  }
  bool hostArrived(NSXPCConnection *connection){
    std::lock_guard<std::mutex> lock(mutex);
    if(!connection||[closedPeers containsObject:connection]||!idleExit.arrived((uintptr_t)(__bridge void *)connection))return false;
    [hostConnections addObject:connection];return true;
  }
  bool closing(){std::lock_guard<std::mutex> lock(mutex);return idleExit.closing();}
  void disconnected(NSXPCConnection *connection){
    if(!connection)return;
    std::lock_guard<std::mutex> lock(mutex);[closedPeers addObject:connection];
    [hostConnections removeObject:connection];idleExit.left((uintptr_t)(__bridge void *)connection,BoperContinuousNs());
    // KEY ownership outlives any one management connection. Other callers in
    // the same group can keep renewing; expiry covers abandoned delegations.
    if(worker==connection){if(valid)invalidate();worker=nil;}
  }
  template<typename Report>bool report(Report value,std::function<bool()> permit){
    auto semaphore=dispatch_semaphore_create(0);auto result=std::make_shared<std::atomic<bool>>(false);
    client->boper_post_report(value,std::move(permit),[semaphore,result](bool ok){*result=ok;dispatch_semaphore_signal(semaphore);});
    if(dispatch_semaphore_wait(semaphore,dispatch_time(DISPATCH_TIME_NOW,250*NSEC_PER_MSEC)))return false;
    return result->load();
  }
  bool reset(){
    // Both zero reports use this client's own devices, ordered after the final
    // accepted report. Daemon receipt is not a driver or target-application ACK.
    if(!connected){fault=true;return false;}
    bool k=report(rep::keyboard_input{},[this]{return connected.load();});
    bool p=report(rep::pointing_input{},[this]{return connected.load();});
    if(!k||!p)fault=true;return k&&p;
  }
  NSDictionary *status(NSDictionary *r){
    if(r[@"key"]&&!BoperValidKey(r[@"key"]))return BoperError(@"E_KEY_INVALID",@"KEY must contain exactly 24 ASCII letters, digits, '_' or '-'");
    std::lock_guard<std::mutex> lock(mutex);
    return @{@"ok":@YES,@"result":@{@"ready":@(ready()),@"protocolVersion":@(protocolVersion),@"clientProtocolVersion":@7,@"connected":@(connected.load()),@"keyboardReady":@(keyboardReady.load()),@"pointingReady":@(pointingReady.load()),@"driverVersionMismatched":@(mismatch.load()),@"fault":@(fault.load()),@"sessionActive":@(valid.load()),@"groupActive":@(valid.load()&&BoperValidKey(r[@"key"])&&[r[@"key"]isEqual:groupKey]),@"releaseLevel":@"daemon-received",@"automaticPhysicalTakeover":@NO}};
  }
  NSDictionary *recover(NSXPCConnection *connection,NSDictionary *r){
    if(!BoperValidKey(r[@"key"]))return BoperError(@"E_KEY_INVALID",@"KEY must contain exactly 24 ASCII letters, digits, '_' or '-'");
    if(!consoleSession(connection.effectiveUserIdentifier,connection.auditSessionIdentifier))return BoperError(@"E_USER_SESSION",@"Recovery requires the unlocked console login session");
    uint64_t reservedEpoch;
    {std::lock_guard<std::mutex> lock(mutex);
      if(!BoperGroupCanRecover(r,groupKey,valid.load(),transition)||pendingReleases)return BoperError(@"E_HELPER_BUSY",@"Another KEY group or a pending release owns the virtual devices");
      if(valid&&(connection.effectiveUserIdentifier!=uid.load()||connection.auditSessionIdentifier!=asid.load()))return BoperError(@"E_USER_SESSION",@"Active recovery belongs to another console login session");
      if(!transportReady())return BoperError(@"E_VIRTUAL_HID_NOT_READY",@"Recovery requires a connected compatible keyboard and pointing device");
      transition=true;valid=false;token=@"";worker=nil;workerPid=0;releaseConfirmed=false;reservedEpoch=++epoch;
    }
    // No authority mutex is held across the output barrier. Already admitted
    // old reports fail their epoch check before these two client-local zeros.
    __block bool clean=false;dispatch_sync(outputQueue, ^{clean=reset();});
    bool sameConsole=consoleSession(connection.effectiveUserIdentifier,connection.auditSessionIdentifier);
    {std::lock_guard<std::mutex> lock(mutex);transition=false;
      if(!clean||reservedEpoch!=epoch||valid||!transportReady()||!sameConsole){fault=true;return BoperError(@"E_RELEASE_UNKNOWN",@"Recovery did not establish acknowledged released devices in the same console session");}
      fault=false;worker=nil;workerPid=0;groupKey=@"";session=@"";lastSeq=0;lastNs=0;
    }
    NSMutableDictionary *result=[status(r)[@"result"]mutableCopy];
    result[@"recovered"]=@YES;result[@"releaseConfirmed"]=@YES;result[@"deviceReleaseConfirmed"]=@NO;
    return @{@"ok":@YES,@"result":result};
  }
  NSDictionary *authorize(NSXPCConnection *connection,NSDictionary *r){
    if(!BoperValidKey(r[@"key"]))return BoperError(@"E_KEY_INVALID",@"KEY must contain exactly 24 ASCII letters, digits, '_' or '-'");
    if(!consoleSession(connection.effectiveUserIdentifier,connection.auditSessionIdentifier))return BoperError(@"E_USER_SESSION",@"Caller must belong to the unlocked console login session");
    if(!boundedString(r[@"inputSessionId"],8,160)||!integer(r[@"pid"],2,INT_MAX)||!boundedString(r[@"delegationToken"],64,64)||!integer(r[@"leaseMs"],250,maxLeaseMs))return BoperError(@"E_AUTH_REQUEST",@"Invalid bounded worker authorization");
    uint64_t reservedEpoch;
    {std::lock_guard<std::mutex> lock(mutex);
      if(valid||transition||pendingReleases)return BoperError(@"E_HELPER_BUSY",@"Another BOPER input session or release owns the virtual devices");
      if(!ready())return BoperError(@"E_VIRTUAL_HID_NOT_READY",@"Virtual keyboard and pointing devices are not both ready");
      // Retired workers keep only release ownership, until this reservation.
      // Their later disconnect/stop must not affect the new opening.
      transition=true;worker=nil;workerPid=0;releaseConfirmed=false;reservedEpoch=++epoch;
    }
    // Never wait for the output queue while holding the authority mutex: an
    // older report's final permit check may still need that mutex.
    __block bool clean=false;dispatch_sync(outputQueue, ^{clean=reset();});
    bool sameConsole=consoleSession(connection.effectiveUserIdentifier,connection.auditSessionIdentifier);
    std::lock_guard<std::mutex> lock(mutex);transition=false;
    if(!clean||reservedEpoch!=epoch||!ready()||!sameConsole||[closedPeers containsObject:connection])return BoperError(@"E_RELEASE_UNKNOWN",@"The previous virtual state could not be released in the same console session");
    worker=nil;groupKey=s(r[@"key"]);session=s(r[@"inputSessionId"]);token=s(r[@"delegationToken"]);workerPid=[r[@"pid"] intValue];uid=connection.effectiveUserIdentifier;asid=connection.auditSessionIdentifier;
    lastSeq=0;lastNs=0;++epoch;expires=BoperContinuousNs()+[r[@"leaseMs"] unsignedLongLongValue]*NSEC_PER_MSEC;consoleAllowed=true;valid=true;
    return @{@"ok":@YES,@"result":@{@"authorized":@YES}};
  }
  NSDictionary *renew(NSXPCConnection *connection,NSDictionary *r){
    if(!BoperValidKey(r[@"key"]))return BoperError(@"E_KEY_INVALID",@"KEY must contain exactly 24 ASCII letters, digits, '_' or '-'");
    if(!consoleSession(connection.effectiveUserIdentifier,connection.auditSessionIdentifier))return BoperError(@"E_USER_SESSION",@"Renewal requires the unlocked console login session");
    std::lock_guard<std::mutex> lock(mutex);
    if(!valid||!BoperGroupMatches(r,groupKey,session)||connection.effectiveUserIdentifier!=uid.load()||connection.auditSessionIdentifier!=asid.load())return BoperError(@"E_SESSION_MISMATCH",@"Only the current KEY group can renew this session");
    if(!integer(r[@"leaseMs"],250,maxLeaseMs))return BoperError(@"E_LEASE_RANGE",@"Lease is outside 250..3000ms");
    if(BoperContinuousNs()>=expires.load()||!consoleAllowed){invalidate();return BoperError(@"E_SESSION_EXPIRED",@"Input authority expired");}
    expires=BoperContinuousNs()+[r[@"leaseMs"] unsignedLongLongValue]*NSEC_PER_MSEC;return @{@"ok":@YES,@"result":@{@"renewed":@YES}};
  }
  NSDictionary *open(NSXPCConnection *connection,NSDictionary *r){
    std::lock_guard<std::mutex> lock(mutex);
    if(!valid||worker||connection.processIdentifier!=workerPid||connection.effectiveUserIdentifier!=uid.load()||connection.auditSessionIdentifier!=asid.load()||![s(r[@"inputSessionId"]) isEqual:session]||![s(r[@"delegationToken"]) isEqual:token]||BoperContinuousNs()>=expires.load()||!consoleAllowed)return BoperError(@"E_DELEGATION",@"No live host delegation authorizes this signed worker");
    token=@"";worker=connection;return @{@"ok":@YES,@"result":@{@"ready":@(ready())}};
  }
  void stop(NSXPCConnection *connection,NSDictionary *r,bool management,BoperReply reply){
    if(management){
      if(!BoperValidKey(r[@"key"])){reply(BoperError(@"E_KEY_INVALID",@"KEY must contain exactly 24 ASCII letters, digits, '_' or '-'"));return;}
      if(!consoleSession(connection.effectiveUserIdentifier,connection.auditSessionIdentifier)){reply(BoperError(@"E_USER_SESSION",@"Stop requires the unlocked console login session"));return;}
    }
    {std::lock_guard<std::mutex> lock(mutex);
      bool owns=management?(BoperGroupMatches(r,groupKey,session)&&connection.effectiveUserIdentifier==uid.load()&&connection.auditSessionIdentifier==asid.load()):BoperWorkerCanStop(r,connection==worker,session);
      if(!owns){reply(BoperError(@"E_SESSION_MISMATCH",@"Stop belongs to another KEY group or session"));return;}
      if(stopReleasing){
        // Runtime cancellation and management cleanup can ask concurrently.
        // Share this release's bounded receipt instead of reporting it lost.
        if(stopReplies.count>=32){reply(BoperError(@"E_HELPER_BUSY",@"Too many callers are waiting for the same release"));return;}
        [stopReplies addObject:[reply copy]];return;
      }
      if(transition||pendingReleases){reply(BoperError(@"E_HELPER_BUSY",@"A virtual device release is already in progress"));return;}
      if(!valid&&releaseConfirmed){reply(@{@"ok":@YES,@"result":@{@"releaseConfirmed":@YES,@"alreadyReleased":@YES,@"releaseLevel":@"daemon-received",@"deviceReleaseConfirmed":@NO}});return;}
      transition=true;stopReleasing=true;releaseConfirmed=false;valid=false;++epoch;token=@"";workerPid=0;
      [stopReplies addObject:[reply copy]];
    }
    dispatch_async(outputQueue, ^{@autoreleasepool{
      bool ok=reset();NSArray *replies;
      {std::lock_guard<std::mutex> lock(mutex);releaseConfirmed=ok;stopReleasing=false;transition=false;replies=[stopReplies copy];[stopReplies removeAllObjects];}
      NSDictionary *receipt=ok?@{@"ok":@YES,@"result":@{@"releaseConfirmed":@YES,@"releaseLevel":@"daemon-received",@"deviceReleaseConfirmed":@NO}}:BoperError(@"E_RELEASE_UNKNOWN",@"Virtual release could not be acknowledged by the daemon");
      for(BoperReply waiting in replies)waiting(receipt);
    }});
  }
  void submit(NSXPCConnection *connection,NSDictionary *r,BoperReply reply){
    if(!integer(r[@"reportSeq"],1,maxReports)||![r[@"deadlineNs"] isKindOfClass:NSNumber.class]){reply(BoperError(@"E_REPORT_ENVELOPE",@"Invalid report envelope"));return;}
    uint64_t sequence=[r[@"reportSeq"] unsignedLongLongValue],reportDeadline=[r[@"deadlineNs"] unsignedLongLongValue],e=epoch.load();
    {std::lock_guard<std::mutex> lock(mutex);
      if(!valid||connection!=worker||![s(r[@"inputSessionId"])isEqual:session]){reply(BoperError(@"E_SESSION_MISMATCH",@"No active input authority accepts this report"));return;}
    }
    NSString *kind=s(r[@"kind"]);rep::keyboard_input keyboard;rep::pointing_input pointing;
    if([kind isEqual:@"keyboard"]){
      if(!integer(r[@"modifiers"],0,255)||![r[@"keys"] isKindOfClass:NSArray.class]||[r[@"keys"] count]>6){reply(BoperError(@"E_KEYBOARD_REPORT",@"Invalid complete keyboard state"));return;}
      for(id k in r[@"keys"]){if(!integer(k,4,221)){reply(BoperError(@"E_KEYBOARD_REPORT",@"Invalid keyboard usage"));return;}keyboard.keys.insert([k unsignedShortValue]);}
      for(int bit=0;bit<8;++bit)if([r[@"modifiers"] intValue]&(1<<bit))keyboard.modifiers.insert(static_cast<rep::modifier>(1<<bit));
    }else if([kind isEqual:@"pointing"]){
      if(!integer(r[@"dx"],-127,127)||!integer(r[@"dy"],-127,127)||!integer(r[@"verticalWheel"],-127,127)||!integer(r[@"horizontalWheel"],-127,127)||!integer(r[@"buttons"],0,7)){reply(BoperError(@"E_POINTING_REPORT",@"Invalid bounded pointing report"));return;}
      pointing.x=static_cast<uint8_t>([r[@"dx"] intValue]);pointing.y=static_cast<uint8_t>([r[@"dy"] intValue]);pointing.vertical_wheel=static_cast<uint8_t>([r[@"verticalWheel"] intValue]);pointing.horizontal_wheel=static_cast<uint8_t>([r[@"horizontalWheel"] intValue]);
      for(int bit=0;bit<3;++bit)if([r[@"buttons"] intValue]&(1<<bit))pointing.buttons.insert(bit+1);
    }else{reply(BoperError(@"E_REPORT_KIND",@"Unsupported report kind"));return;}
    // Per-connection XPC serializes entry. An additional pending flag prevents
    // a compromised signed worker from filling the helper's output queue.
    static std::atomic<bool> pending{false};bool expected=false;
    if(!pending.compare_exchange_strong(expected,true)){reply(BoperError(@"E_REPORT_WINDOW",@"Only one HID report may be outstanding"));return;}
    dispatch_async(outputQueue, ^{@autoreleasepool{
      auto permit=[this,connection,r,e,sequence,reportDeadline]{
        std::lock_guard<std::mutex> lock(mutex);uint64_t now=BoperContinuousNs();
        return valid&&ready()&&e==epoch&&connection==worker&&[s(r[@"inputSessionId"]) isEqual:session]&&sequence==lastSeq+1&&sequence<=maxReports&&now<expires&&now<reportDeadline&&reportDeadline-now<=150*NSEC_PER_MSEC&&now>=lastNs+4*NSEC_PER_MSEC&&consoleAllowed;
      };
      bool ok=false;if(permit())ok=[kind isEqual:@"keyboard"]?report(keyboard,permit):report(pointing,permit);
      if(ok){std::lock_guard<std::mutex> lock(mutex);lastSeq=sequence;lastNs=BoperContinuousNs();}
      else{std::lock_guard<std::mutex> lock(mutex);if(e==epoch&&connection==worker&&[s(r[@"inputSessionId"])isEqual:session]){fault=true;invalidate();}}
      pending=false;
      reply(ok?@{@"ok":@YES,@"result":@{@"reportSeq":@(sequence),@"receipt":@"daemon-received",@"targetVerified":@NO}}:BoperError(@"E_REPORT_REJECTED",@"Report expired, lost authority or was not acknowledged; session stopped"));
    }});
  }
};

@interface Peer:NSObject<BoperHostProtocol,BoperInputProtocol>
@property Engine *engine;
@property(weak) NSXPCConnection *connection;
@property BOOL hostRole;
@end
@implementation Peer
- (BOOL)hostAvailable:(BoperReply)reply{if(!_hostRole){reply(BoperError(@"E_ROLE",@"Host role required"));return NO;}if(!_engine->hostArrived(_connection)){reply(BoperError(@"E_HELPER_CLOSING",@"Idle BOPER helper is finishing its own device release"));return NO;}return YES;}
- (void)status:(NSDictionary *)r reply:(BoperReply)reply{if([self hostAvailable:reply])reply(_engine->status(r));}
- (void)recover:(NSDictionary *)r reply:(BoperReply)reply{if([self hostAvailable:reply])reply(_engine->recover(_connection,r));}
- (void)authorize:(NSDictionary *)r reply:(BoperReply)reply{if([self hostAvailable:reply])reply(_engine->authorize(_connection,r));}
- (void)renew:(NSDictionary *)r reply:(BoperReply)reply{if([self hostAvailable:reply])reply(_engine->renew(_connection,r));}
- (void)revoke:(NSDictionary *)r reply:(BoperReply)reply{if([self hostAvailable:reply])_engine->stop(_connection,r,true,reply);}
- (void)open:(NSDictionary *)r reply:(BoperReply)reply{reply(!_hostRole?_engine->open(_connection,r):BoperError(@"E_ROLE",@"Worker role required"));}
- (void)submit:(NSDictionary *)r reply:(BoperReply)reply{if(!_hostRole)_engine->submit(_connection,r,reply);else reply(BoperError(@"E_ROLE",@"Worker role required"));}
- (void)stop:(NSDictionary *)r reply:(BoperReply)reply{_engine->stop(_connection,r,_hostRole,reply);}
@end
@interface Listener:NSObject<NSXPCListenerDelegate>
@property Engine *engine;
@property BOOL hostRole;
@end
@implementation Listener
- (BOOL)listener:(NSXPCListener *)listener shouldAcceptNewConnection:(NSXPCConnection *)connection{
  if(_engine->closing()||connection.effectiveUserIdentifier==0||!consoleSession(connection.effectiveUserIdentifier,connection.auditSessionIdentifier))return NO;
  if(!_hostRole){@try{[connection setCodeSigningRequirement:@BOPER_RUNTIME_REQUIREMENT];}@catch(NSException *){return NO;}}
  Peer *peer=[Peer new];peer.engine=_engine;peer.connection=connection;peer.hostRole=_hostRole;
  connection.exportedInterface=BoperInterface(_hostRole?@protocol(BoperHostProtocol):@protocol(BoperInputProtocol));connection.exportedObject=peer;
  Engine *engine=_engine;__weak NSXPCConnection *weakConnection=connection;
  connection.invalidationHandler=^{engine->disconnected(weakConnection);};connection.interruptionHandler=^{engine->disconnected(weakConnection);};
  [connection resume];return YES;
}
@end
static io_connect_t powerConnection=0;
int main(int argc,char **argv){@autoreleasepool{
  if(argc==2&&!strcmp(argv[1],"--self-test")){
    if(!integer(@127,-127,127)||integer(@128,-127,127)||integer(@1.2,0,255))return 1;
    NSString *key=@"AbCdEfGhIjKlMnOpQrStUv_-",*other=@"123456789012345678901234",*session=@"synthetic-session";
    if(!BoperValidKey(key)||!BoperValidKey(other))return 7;
    for(id invalid in @[@"",@"AbCdEfGhIjKlMnOpQrStUv_",@"AbCdEfGhIjKlMnOpQrStUv_-0",@"AbCdEfGhIjKlMnOpQrStUv_中",@42,NSNull.null])if(BoperValidKey(invalid))return 8;
    for(unsigned c=0;c<128;++c){
      NSString *candidate=[key stringByReplacingCharactersInRange:NSMakeRange(0,1) withString:[NSString stringWithCharacters:(unichar[]){(unichar)c} length:1]];
      bool allowed=(c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='_'||c=='-';
      if(BoperValidKey(candidate)!=allowed)return 9;
    }
    // The policy deliberately has no process/connection identity input. Equal
    // KEYs share a group; an optional session still guards delayed cleanups.
    if(!BoperGroupMatches(@{@"key":key},key,session)||!BoperGroupMatches(@{@"key":key,@"inputSessionId":session},key,session))return 10;
    if(BoperGroupMatches(@{@"key":other},key,session)||BoperGroupMatches(@{@"key":key,@"inputSessionId":@"older-session"},key,session)||BoperGroupMatches(@{@"key":key,@"inputSessionId":NSNull.null},key,session)||BoperGroupMatches(@{},key,session))return 11;
    if(!BoperGroupCanRecover(@{@"key":key},key,true,false)||BoperGroupCanRecover(@{@"key":other},key,true,false)||!BoperGroupCanRecover(@{@"key":other},key,false,false)||BoperGroupCanRecover(@{@"key":key},key,false,true)||BoperGroupCanRecover(@{},key,false,false))return 12;
    // Stopping a released worker remains valid without restoring its report
    // authority. Replacing either its connection or session removes that right.
    if(!BoperWorkerCanStop(@{@"inputSessionId":session},true,session)||BoperWorkerCanStop(@{@"inputSessionId":session},false,session)||BoperWorkerCanStop(@{@"inputSessionId":session},true,@"replacement-session")||BoperWorkerCanStop(@{},true,session))return 13;
    IdleExitGate gate;gate.left(9,1);if(gate.begin(999999999,false,false))return 2;
    gate.arrived(1);gate.arrived(2);gate.left(1,1);if(gate.begin(999999999,false,false))return 3;
    gate.left(2,100);if(gate.begin(100000099,false,false)||gate.begin(200000000,true,false)||gate.begin(200000000,false,true))return 4;
    gate.arrived(3);if(gate.begin(300000000,false,false))return 5;gate.left(3,300000000);
    if(!gate.begin(400000001,false,false)||gate.arrived(4))return 6;
    puts("{\"ok\":true,\"inputDispatched\":false,\"selfTest\":\"helper-envelope-key-group-and-local-idle-exit\"}");return 0;
  }
  if(geteuid()!=0){fputs("BOPER HID helper requires its administrator-installed root LaunchDaemon\n",stderr);return 77;}
  Engine *engine=new Engine();
  Listener *control=[Listener new];control.engine=engine;control.hostRole=YES;Listener *input=[Listener new];input.engine=engine;input.hostRole=NO;
  NSXPCListener *a=[[NSXPCListener alloc]initWithMachServiceName:BoperControlService];a.delegate=control;[a resume];
  NSXPCListener *b=[[NSXPCListener alloc]initWithMachServiceName:BoperInputService];b.delegate=input;[b resume];
  [[NSDistributedNotificationCenter defaultCenter]addObserverForName:@"com.apple.screenIsLocked" object:nil queue:nil usingBlock:^(NSNotification *){engine->invalidate();}];
  IONotificationPortRef port=nullptr;io_object_t notifier=0;
  powerConnection=IORegisterForSystemPower(engine,&port,[](void *context,io_service_t,natural_t message,void *argument){if(message==kIOMessageSystemWillSleep||message==kIOMessageCanSystemSleep){static_cast<Engine *>(context)->invalidate();IOAllowPowerChange(powerConnection,(long)argument);} },&notifier);
  // We do not delay or veto system sleep. Lease expiration uses continuous time.
  if(port)CFRunLoopAddSource(CFRunLoopGetCurrent(),IONotificationPortGetRunLoopSource(port),kCFRunLoopDefaultMode);
  CFRunLoopRun();
}}
