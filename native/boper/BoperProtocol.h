#pragma once
#import <Foundation/Foundation.h>
#import <mach/mach_time.h>

// Local console programs manage KEY groups over the control interface. The
// separate input interface still admits only the pinned BOPER runtime.
static NSString *const BoperControlService = @"cn.haminn.workbunny.boper-hid.control";
static NSString *const BoperInputService = @"cn.haminn.workbunny.boper-hid.input";
static NSString *const BoperDaemonPlist = @"cn.haminn.workbunny.boper-hid.plist";
static NSString *const BoperInstalledHelper = @"/Library/PrivilegedHelperTools/cn.haminn.workbunny.boper-hid";
static NSString *const BoperInstalledPlist = @"/Library/LaunchDaemons/cn.haminn.workbunny.boper-hid.plist";
typedef void (^BoperReply)(NSDictionary *reply);
@protocol BoperHostProtocol
- (void)status:(NSDictionary *)request reply:(BoperReply)reply;
- (void)recover:(NSDictionary *)request reply:(BoperReply)reply;
- (void)authorize:(NSDictionary *)request reply:(BoperReply)reply;
- (void)renew:(NSDictionary *)request reply:(BoperReply)reply;
- (void)revoke:(NSDictionary *)request reply:(BoperReply)reply;
@end
@protocol BoperInputProtocol
- (void)open:(NSDictionary *)request reply:(BoperReply)reply;
- (void)submit:(NSDictionary *)request reply:(BoperReply)reply;
- (void)stop:(NSDictionary *)request reply:(BoperReply)reply;
@end

static inline NSXPCInterface *BoperInterface(Protocol *protocol) {
  NSXPCInterface *iface = [NSXPCInterface interfaceWithProtocol:protocol];
  NSSet *classes = [NSSet setWithObjects:NSDictionary.class,NSArray.class,NSString.class,NSNumber.class,NSNull.class,nil];
  if (protocol == @protocol(BoperHostProtocol)) {
    for (NSString *name in @[@"status:reply:",@"recover:reply:",@"authorize:reply:",@"renew:reply:",@"revoke:reply:"]) {
      SEL sel = NSSelectorFromString(name);
      [iface setClasses:classes forSelector:sel argumentIndex:0 ofReply:NO];
      [iface setClasses:classes forSelector:sel argumentIndex:0 ofReply:YES];
    }
  } else {
    for (NSString *name in @[@"open:reply:",@"submit:reply:",@"stop:reply:"]) {
      SEL sel = NSSelectorFromString(name);
      [iface setClasses:classes forSelector:sel argumentIndex:0 ofReply:NO];
      [iface setClasses:classes forSelector:sel argumentIndex:0 ofReply:YES];
    }
  }
  return iface;
}
static inline NSDictionary *BoperError(NSString *code, NSString *message) {
  return @{@"ok":@NO,@"error":@{@"code":code,@"message":message}};
}
// Fixed-length ASCII avoids Unicode normalization and ambiguous group names.
static inline bool BoperValidKey(id value) {
  if (![value isKindOfClass:NSString.class] || [value length] != 24) return false;
  for (NSUInteger i=0;i<24;++i) {
    unichar c=[value characterAtIndex:i];
    if (!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='_'||c=='-')) return false;
  }
  return true;
}
static inline bool BoperGroupMatches(NSDictionary *request, NSString *key, NSString *session) {
  if (!BoperValidKey(request[@"key"]) || ![request[@"key"] isEqual:key]) return false;
  id requestedSession=request[@"inputSessionId"];
  return !requestedSession || ([requestedSession isKindOfClass:NSString.class] && [requestedSession isEqual:session]);
}
static inline bool BoperGroupCanRecover(NSDictionary *request, NSString *key, bool active, bool transition) {
  return BoperValidKey(request[@"key"]) && !transition && (!active || [request[@"key"] isEqual:key]);
}
static inline bool BoperWorkerCanStop(NSDictionary *request, bool currentWorker, NSString *session) {
  return currentWorker && [request[@"inputSessionId"] isKindOfClass:NSString.class] && [request[@"inputSessionId"] isEqual:session];
}
static inline uint64_t BoperContinuousNs(void) {
  static mach_timebase_info_data_t info;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ mach_timebase_info(&info); });
  return (uint64_t)((__uint128_t)mach_continuous_time() * info.numer / info.denom);
}
