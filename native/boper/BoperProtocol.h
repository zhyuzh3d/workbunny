#pragma once
#import <Foundation/Foundation.h>
#import <mach/mach_time.h>

// Deliberately separate Mach services and interfaces: a signed worker cannot
// call the host's authority methods, even when launched outside Bunny.
static NSString *const BoperControlService = @"cn.haminn.workbunny.boper-hid.control";
static NSString *const BoperInputService = @"cn.haminn.workbunny.boper-hid.input";
static NSString *const BoperDaemonPlist = @"cn.haminn.workbunny.boper-hid.plist";
static NSString *const BoperInstalledHelper = @"/Library/PrivilegedHelperTools/cn.haminn.workbunny.boper-hid";
static NSString *const BoperInstalledPlist = @"/Library/LaunchDaemons/cn.haminn.workbunny.boper-hid.plist";
typedef void (^BoperReply)(NSDictionary *reply);
@protocol BoperHostProtocol
- (void)statusWithReply:(BoperReply)reply;
- (void)recoverWithReply:(BoperReply)reply;
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
    [iface setClasses:classes forSelector:@selector(statusWithReply:) argumentIndex:0 ofReply:YES];
    [iface setClasses:classes forSelector:@selector(recoverWithReply:) argumentIndex:0 ofReply:YES];
    for (NSString *name in @[@"authorize:reply:",@"renew:reply:",@"revoke:reply:"]) {
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
static inline uint64_t BoperContinuousNs(void) {
  static mach_timebase_info_data_t info;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ mach_timebase_info(&info); });
  return (uint64_t)((__uint128_t)mach_continuous_time() * info.numer / info.denom);
}
