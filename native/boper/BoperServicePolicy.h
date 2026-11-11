#pragma once
#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>

static inline NSString *BoperServiceState(SMAppServiceStatus status) {
  switch(status) {
    case SMAppServiceStatusEnabled: return @"enabled";
    case SMAppServiceStatusRequiresApproval: return @"requires-approval";
    case SMAppServiceStatusNotFound: return @"not-found";
    default: return @"not-registered";
  }
}

// registerAndReturnError may report EPERM after successfully adding the daemon
// to Background Task Management, while status becomes RequiresApproval. That
// state requires administrator approval; it is not an installed/running helper
// and must not be persisted as an input/driver fault. An EPERM with any other
// resulting status remains an error. Unregister errors are never normalized.
static inline NSDictionary *BoperRegistrationResponse(BOOL registering, BOOL succeeded,
                                                       SMAppServiceStatus resultingStatus,
                                                       NSError *error) {
  BOOL pending=registering&&resultingStatus==SMAppServiceStatusRequiresApproval;
  BOOL settings=registering&&[error.domain isEqual:@"SMAppServiceErrorDomain"]&&error.code==1;
  if(!succeeded&&!pending) {
    NSMutableDictionary *failure=[@{
      @"code":@"E_SERVICE_MANAGEMENT",
      @"message":settings?@"macOS 未允许启动 BOPER 后台服务。请打开系统设置 → 通用 → 登录项与扩展，检查 WorkBunny 的后台运行设置，再返回重新检测。":error.localizedDescription?:@"Service management failed",
      @"nativeCode":@(error.code),
      @"nativeDomain":error.domain?:@"",
      @"serviceStatus":BoperServiceState(resultingStatus)
    } mutableCopy];
    if(settings){failure[@"settingsRequired"]=@YES;failure[@"recoveryAction"]=@"open-login-items";}
    return @{@"ok":@NO,@"error":failure};
  }
  return @{@"ok":@YES,@"result":@{
    @"serviceStatus":BoperServiceState(resultingStatus),
    @"approvalRequired":@(resultingStatus==SMAppServiceStatusRequiresApproval),
    @"settingsRequired":@(pending),
    @"recoveryAction":pending?@"open-login-items":@"",
    @"ready":@NO
  }};
}
