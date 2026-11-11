#import "BoperServicePolicy.h"

int main(){@autoreleasepool{
  NSError *denied=[NSError errorWithDomain:@"SMAppServiceErrorDomain" code:1 userInfo:@{NSLocalizedDescriptionKey:@"Operation not permitted"}];
  NSDictionary *pending=BoperRegistrationResponse(YES,NO,SMAppServiceStatusRequiresApproval,denied);
  if(![pending[@"ok"]boolValue]||![pending[@"result"][@"approvalRequired"]boolValue]||[pending[@"result"][@"ready"]boolValue])return 1;
  NSDictionary *genuineFailure=BoperRegistrationResponse(YES,NO,SMAppServiceStatusNotFound,denied);
  if([genuineFailure[@"ok"]boolValue]||![genuineFailure[@"error"][@"nativeDomain"]isEqual:@"SMAppServiceErrorDomain"]||[genuineFailure[@"error"][@"nativeCode"]integerValue]!=1||![genuineFailure[@"error"][@"serviceStatus"]isEqual:@"not-found"]||![genuineFailure[@"error"][@"settingsRequired"]boolValue]||![genuineFailure[@"error"][@"recoveryAction"]isEqual:@"open-login-items"])return 2;
  NSDictionary *unregisterFailure=BoperRegistrationResponse(NO,NO,SMAppServiceStatusRequiresApproval,denied);
  if([unregisterFailure[@"ok"]boolValue]||[unregisterFailure[@"error"][@"settingsRequired"]boolValue])return 3;
  NSDictionary *enabled=BoperRegistrationResponse(YES,YES,SMAppServiceStatusEnabled,nil);
  if(![enabled[@"ok"]boolValue]||[enabled[@"result"][@"approvalRequired"]boolValue]||[enabled[@"result"][@"ready"]boolValue])return 4;
  NSError *posix=[NSError errorWithDomain:NSPOSIXErrorDomain code:1 userInfo:nil];
  NSDictionary *unrelated=BoperRegistrationResponse(YES,NO,SMAppServiceStatusNotRegistered,posix);
  if([unrelated[@"ok"]boolValue]||[unrelated[@"error"][@"settingsRequired"]boolValue])return 5;
  puts("{\"ok\":true,\"selfTest\":\"registration-approval-versus-real-permission-failure\",\"inputDispatched\":false}");return 0;
}}
