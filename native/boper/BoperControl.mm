#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <ServiceManagement/ServiceManagement.h>
#import "BoperProtocol.h"
#import "BoperSecurity.h"
#import "BoperServicePolicy.h"
#include <node_api.h>
#include <mutex>
#include <atomic>
#include <memory>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

static std::mutex connectionMutex;
static NSXPCConnection *connection;
static std::atomic<int> sealedHost{-1};
static std::mutex sealMutex;
static void clearConnection(NSXPCConnection *expected=nil){
  NSXPCConnection *old;
  {std::lock_guard<std::mutex> lock(connectionMutex);old=expected?:connection;if(connection==old){connection=nil;sealedHost=-1;}}
  // Invalidating under connectionMutex can synchronously schedule a handler
  // that needs the same lock. An old handler must not clear a new connection.
  [old invalidate];
}
static bool hostContext(){
  NSBundle *bundle=NSBundle.mainBundle;
  if(![bundle.bundleIdentifier isEqual:@"cn.haminn.workbunny"]||![bundle.bundlePath.pathExtension isEqual:@"app"])return false;
  NSDictionary *environment=NSProcessInfo.processInfo.environment;
  for(NSString *name in environment)if([name hasPrefix:@"DYLD_"]||[name isEqual:@"NODE_OPTIONS"]||[name isEqual:@"ELECTRON_RUN_AS_NODE"])return false;
  NSArray *forbidden=@[@"--inspect",@"--remote-debugging",@"--eval",@"--require",@"--run-as-node",@"--js-flags",@"--app",@"--disable-web-security",@"--extensions"];
  for(NSString *argument in NSProcessInfo.processInfo.arguments){
    if([argument isEqual:@"-e"]||[argument isEqual:@"-r"])return false;
    for(NSString *prefix in forbidden)if([argument hasPrefix:prefix])return false;
  }
  int cached=sealedHost.load();if(cached>=0)return cached==1;
  std::lock_guard<std::mutex> lock(sealMutex);cached=sealedHost.load();if(cached>=0)return cached==1;
  SecCodeRef selfCode=nullptr;SecStaticCodeRef code=nullptr;SecRequirementRef requirement=nullptr;
  OSStatus e=SecCodeCopySelf(kSecCSDefaultFlags,&selfCode);
  if(!e)e=SecCodeCopyStaticCode(selfCode,kSecCSDefaultFlags,&code);
  if(!e)e=SecRequirementCreateWithString(CFSTR(BOPER_HOST_REQUIREMENT),kSecCSDefaultFlags,&requirement);
  if(!e)e=SecStaticCodeCheckValidity(code,kSecCSStrictValidate|kSecCSCheckNestedCode|kSecCSCheckAllArchitectures,requirement);
  if(requirement)CFRelease(requirement);if(code)CFRelease(code);if(selfCode)CFRelease(selfCode);sealedHost=e==errSecSuccess?1:0;return e==errSecSuccess;
}
static NSDictionary *hostRPC(NSString *action,NSDictionary *params){
  NSXPCConnection *c;
  {std::lock_guard<std::mutex> lock(connectionMutex);if(!connection){
    connection=[[NSXPCConnection alloc]initWithMachServiceName:BoperControlService options:NSXPCConnectionPrivileged];
    [connection setCodeSigningRequirement:@BOPER_HELPER_REQUIREMENT];connection.remoteObjectInterface=BoperInterface(@protocol(BoperHostProtocol));
    __weak NSXPCConnection *expected=connection;
    connection.invalidationHandler=^{std::lock_guard<std::mutex> lock(connectionMutex);if(connection==expected){connection=nil;sealedHost=-1;}};[connection resume];
  }c=connection;}
  __block NSDictionary *response;dispatch_semaphore_t semaphore=dispatch_semaphore_create(0);
  id<BoperHostProtocol>proxy=[c remoteObjectProxyWithErrorHandler:^(NSError *e){response=BoperError(@"E_HELPER_DISCONNECTED",e.localizedDescription?:@"Helper disconnected");clearConnection(c);dispatch_semaphore_signal(semaphore);}];
  BoperReply reply=^(NSDictionary *value){response=value;dispatch_semaphore_signal(semaphore);};
  if([action isEqual:@"status"])[proxy statusWithReply:reply];
  else if([action isEqual:@"recover"])[proxy recoverWithReply:reply];
  else if([action isEqual:@"authorizeRuntime"])[proxy authorize:params reply:reply];
  else if([action isEqual:@"renewSession"])[proxy renew:params reply:reply];
  else [proxy revoke:params reply:reply];
  unsigned timeout=([action isEqual:@"authorizeRuntime"]||[action isEqual:@"recover"])?10000:1200;
  if(dispatch_semaphore_wait(semaphore,dispatch_time(DISPATCH_TIME_NOW,timeout*NSEC_PER_MSEC))){clearConnection(c);return BoperError(@"E_HELPER_TIMEOUT",@"Authenticated helper did not reply within its bound");}
  if(![response[@"ok"]boolValue])clearConnection(c);
  return response?:BoperError(@"E_HELPER_DISCONNECTED",@"Authenticated helper returned no response");
}

static NSDictionary *unregisterLegacyService(){
  SMAppService *service=[SMAppService daemonServiceWithPlistName:BoperDaemonPlist];
  SMAppServiceStatus before=service.status;
  if(before==SMAppServiceStatusNotRegistered||before==SMAppServiceStatusNotFound)
    return @{@"ok":@YES,@"result":@{@"legacyUnregistered":@YES,@"legacyServiceStatus":BoperServiceState(before),@"ready":@NO}};
  __block NSDictionary *response;
  dispatch_semaphore_t finished=dispatch_semaphore_create(0);
  auto active=std::make_shared<std::atomic<bool>>(true);
  const uint64_t deadline=BoperContinuousNs()+8*NSEC_PER_SEC;
  void (^finish)(NSDictionary *)=^(NSDictionary *value){
    if(!active->load()||BoperContinuousNs()>=deadline)return;
    response=value;dispatch_semaphore_signal(finished);
  };
  // Migration only, before the administrator installs the fixed root job.
  // This addon never registers a new SMAppService daemon.
  [service unregisterWithCompletionHandler:^(NSError *error){
    if(!active->load()||BoperContinuousNs()>=deadline)return;
    if(error){finish(BoperRegistrationResponse(NO,NO,service.status,error));return;}
    finish(@{@"ok":@YES,@"result":@{@"legacyUnregistered":@YES,@"legacyServiceStatus":BoperServiceState(service.status),@"ready":@NO}});
  }];
  if(dispatch_semaphore_wait(finished,dispatch_time(DISPATCH_TIME_NOW,8*NSEC_PER_SEC))){
    active->store(false);
    return @{@"ok":@NO,@"error":@{@"code":@"E_SERVICE_MANAGEMENT_TIMEOUT",@"message":@"macOS 服务管理未在 8 秒内完成，本次结果不明；请重新检测。",@"serviceStatus":@"unknown",@"serviceMutationMayHaveApplied":@YES}};
  }
  active->store(false);return response;
}

static bool rootOwnedFile(NSString *path,bool directory=false){
  struct stat info;if(lstat(path.fileSystemRepresentation,&info)!=0)return false;
  return (directory?S_ISDIR(info.st_mode):S_ISREG(info.st_mode))&&info.st_uid==0&&info.st_gid==0&&(info.st_mode&0022)==0;
}
static NSString *codeDirectoryHash(SecStaticCodeRef code){
  CFDictionaryRef raw=nullptr;if(SecCodeCopySigningInformation(code,kSecCSSigningInformation,&raw)!=errSecSuccess||!raw)return @"";
  NSDictionary *info=CFBridgingRelease(raw);NSData *hash=info[(__bridge id)kSecCodeInfoUnique];
  if(![hash isKindOfClass:NSData.class])return @"";
  NSMutableString *value=[NSMutableString stringWithCapacity:hash.length*2];const uint8_t *bytes=(const uint8_t *)hash.bytes;
  for(NSUInteger i=0;i<hash.length;++i)[value appendFormat:@"%02x",bytes[i]];return value;
}
static NSString *bundledHelperHash(){
  NSURL *url=[NSBundle.mainBundle.bundleURL URLByAppendingPathComponent:@"Contents/Library/LaunchServices/boper-hid-helper"];
  SecStaticCodeRef code=nullptr;if(SecStaticCodeCreateWithPath((__bridge CFURLRef)url,kSecCSDefaultFlags,&code)!=errSecSuccess)return @"";
  NSString *value=codeDirectoryHash(code);CFRelease(code);return value;
}
static NSDictionary *installedComponents(){
  NSString *bundledHash=bundledHelperHash();
  NSMutableDictionary *result=[@{@"installed":@NO,@"ready":@NO,@"helperConnected":@NO,@"installationMode":@"local-admin-launchdaemon",@"serviceStatus":@"not-found",@"state":@"install-required",@"approvalRequired":@NO,@"settingsRequired":@NO,@"protocolVersion":@1,@"automaticPhysicalTakeover":@NO,@"helperRequirement":@BOPER_HELPER_REQUIREMENT,@"bundledHelperCDHash":bundledHash,@"installedHelperCDHash":@"",@"updateRequired":@YES}mutableCopy];
  struct stat ignored;
  if(lstat(BoperInstalledHelper.fileSystemRepresentation,&ignored)!=0||lstat(BoperInstalledPlist.fileSystemRepresentation,&ignored)!=0){
    result[@"error"]=@{@"code":@"E_HELPER_INSTALL_REQUIRED",@"message":@"BOPER 后台组件尚未安装，需要本机管理员授权安装。"};return result;
  }
  if(!rootOwnedFile(@"/Library/PrivilegedHelperTools",true)||!rootOwnedFile(@"/Library/LaunchDaemons",true)||!rootOwnedFile(BoperInstalledHelper)||!rootOwnedFile(BoperInstalledPlist)||access(BoperInstalledHelper.fileSystemRepresentation,X_OK)!=0){
    result[@"state"]=@"faulted";result[@"error"]=@{@"code":@"E_HELPER_INSTALL_INTEGRITY",@"message":@"BOPER 后台组件的所有者或文件权限不正确，请通过管理员安装修复。"};return result;
  }
  NSDictionary *plist=[NSDictionary dictionaryWithContentsOfFile:BoperInstalledPlist];
  NSDictionary *services=[plist[@"MachServices"]isKindOfClass:NSDictionary.class]?plist[@"MachServices"]:@{};
  if(![plist[@"Label"]isEqual:@"cn.haminn.workbunny.boper-hid"]||![plist[@"Program"]isEqual:BoperInstalledHelper]||plist[@"BundleProgram"]||services.count!=2||![services[BoperControlService]isEqual:@YES]||![services[BoperInputService]isEqual:@YES]){
    result[@"state"]=@"faulted";result[@"error"]=@{@"code":@"E_HELPER_INSTALL_INTEGRITY",@"message":@"BOPER 后台服务配置不符合固定安装契约，请通过管理员安装修复。"};return result;
  }
  SecStaticCodeRef code=nullptr;SecRequirementRef requirement=nullptr;
  OSStatus error=SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:BoperInstalledHelper],kSecCSDefaultFlags,&code);
  if(!error)error=SecRequirementCreateWithString(CFSTR(BOPER_HELPER_REQUIREMENT),kSecCSDefaultFlags,&requirement);
  if(!error)error=SecStaticCodeCheckValidity(code,kSecCSStrictValidate|kSecCSCheckAllArchitectures,requirement);
  if(!error)result[@"installedHelperCDHash"]=codeDirectoryHash(code);
  if(requirement)CFRelease(requirement);if(code)CFRelease(code);
  if(error){result[@"state"]=@"faulted";result[@"error"]=@{@"code":@"E_HELPER_INSTALL_SIGNATURE",@"message":@"BOPER 已安装组件的本地签名与本应用不匹配，需要管理员授权更新。",@"nativeCode":@(error)};return result;}
  BOOL update=bundledHash.length==0||![result[@"installedHelperCDHash"]isEqual:bundledHash];
  result[@"installed"]=@YES;result[@"updateRequired"]=@(update);result[@"serviceStatus"]=@"installed";result[@"state"]=update?@"update-required":@"faulted";
  if(update)result[@"error"]=@{@"code":@"E_HELPER_UPDATE_REQUIRED",@"message":@"BOPER 已安装后台组件与本应用版本不同，需要管理员授权更新。"};return result;
}
static NSDictionary *localServiceStatus(bool trusted){
  NSMutableDictionary *result=[installedComponents()mutableCopy];result[@"hostContextTrusted"]=@(trusted);
  if(trusted&&[result[@"installed"]boolValue]&&![result[@"updateRequired"]boolValue]){
    NSDictionary *reply=hostRPC(@"status",@{});
    if([reply[@"ok"]boolValue]){[result addEntriesFromDictionary:reply[@"result"]];result[@"helperConnected"]=@YES;result[@"serviceStatus"]=@"enabled";result[@"state"]=[result[@"ready"]boolValue]?@"ready":@"faulted";}
    else result[@"error"]=reply[@"error"];
  }
  return result;
}
struct Work{napi_env env;napi_deferred deferred;napi_async_work work;NSString *action;NSDictionary *params;NSDictionary *result;NSDictionary *error;};
static void perform(napi_env env,void *data){
  Work *w=(Work *)data;@autoreleasepool{@try{
    bool trusted=hostContext();
    if([w->action isEqual:@"status"]||[w->action isEqual:@"refresh"]){w->result=localServiceStatus(trusted);return;}
    if(!trusted){w->error=@{@"code":@"E_HOST_CONTEXT",@"message":@"BOPER management requires the sealed signed Bunny app without script or debug flags"};return;}
    if([w->action isEqual:@"openSettings"]){dispatch_async(dispatch_get_main_queue(), ^{[SMAppService openSystemSettingsLoginItems];});w->result=@{@"opened":@YES};return;}
    if([w->action isEqual:@"register"]){NSDictionary *status=localServiceStatus(true);if(status[@"error"])w->error=status[@"error"];else w->result=status;return;}
    if([w->action isEqual:@"unregister"]||[w->action isEqual:@"unregisterLegacyService"]){clearConnection();NSDictionary *reply=unregisterLegacyService();if([reply[@"ok"]boolValue])w->result=reply[@"result"];else w->error=reply[@"error"];return;}
    if(![w->action isEqual:@"renewSession"]&&![w->action isEqual:@"revokeSession"]){NSDictionary *installed=installedComponents();if(installed[@"error"]){w->error=installed[@"error"];return;}}
    NSMutableDictionary *params=[w->params mutableCopy]?:[NSMutableDictionary dictionary];NSString *secret;
    if([w->action isEqual:@"authorizeRuntime"]){
      uint8_t random[32];if(SecRandomCopyBytes(kSecRandomDefault,sizeof(random),random)!=errSecSuccess){w->error=@{@"code":@"E_RANDOM",@"message":@"Secure delegation generation failed"};return;}
      NSMutableString *token=[NSMutableString stringWithCapacity:64];for(unsigned i=0;i<sizeof(random);++i)[token appendFormat:@"%02x",random[i]];secret=token;params[@"delegationToken"]=secret;
    }
    NSDictionary *reply=hostRPC(w->action,params);
    if(![reply[@"ok"]boolValue]){w->error=reply[@"error"];return;}
    NSMutableDictionary *result=[reply[@"result"]mutableCopy]?:[NSMutableDictionary dictionary];if(secret)result[@"delegationToken"]=secret;w->result=result;
  }@catch(NSException *exception){w->error=@{@"code":@"E_NATIVE_CONTROL",@"message":exception.reason?:@"Native control failed"};}}}
static napi_value jsValue(napi_env env,id value){
  NSData *data=[NSJSONSerialization dataWithJSONObject:value?:@{} options:0 error:nil];NSString *json=[[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding];
  napi_value global,JSON,parse,text,result;napi_get_global(env,&global);napi_get_named_property(env,global,"JSON",&JSON);napi_get_named_property(env,JSON,"parse",&parse);napi_create_string_utf8(env,json.UTF8String?:"{}",NAPI_AUTO_LENGTH,&text);napi_call_function(env,JSON,parse,1,&text,&result);return result;
}
static void complete(napi_env env,napi_status status,void *data){Work *w=(Work *)data;@autoreleasepool{
  if(w->error){napi_value error,message,code;napi_create_string_utf8(env,[w->error[@"message"]UTF8String],NAPI_AUTO_LENGTH,&message);napi_create_error(env,nullptr,message,&error);napi_create_string_utf8(env,[w->error[@"code"]UTF8String],NAPI_AUTO_LENGTH,&code);napi_set_named_property(env,error,"code",code);
    for(NSString *name in @[@"nativeCode",@"nativeDomain",@"serviceStatus",@"settingsRequired",@"recoveryAction",@"serviceMutationMayHaveApplied"]){id value=w->error[name];if(!value)continue;napi_value property;if([name isEqual:@"settingsRequired"]||[name isEqual:@"serviceMutationMayHaveApplied"])napi_get_boolean(env,[value boolValue],&property);else if([value isKindOfClass:NSNumber.class])napi_create_int64(env,[value longLongValue],&property);else napi_create_string_utf8(env,[value UTF8String],NAPI_AUTO_LENGTH,&property);napi_set_named_property(env,error,name.UTF8String,property);}
    napi_reject_deferred(env,w->deferred,error);}
  else napi_resolve_deferred(env,w->deferred,jsValue(env,w->result));napi_delete_async_work(env,w->work);delete w;
}}
static napi_value invoke(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value args[1],promise;void *data;napi_get_cb_info(env,info,&argc,args,nullptr,&data);
  Work *w=new Work();w->env=env;w->action=@((const char *)data);w->params=@{};
  if(argc){napi_value global,JSON,stringify,result;napi_get_global(env,&global);napi_get_named_property(env,global,"JSON",&JSON);napi_get_named_property(env,JSON,"stringify",&stringify);
    if(napi_call_function(env,JSON,stringify,1,args,&result)==napi_ok){size_t size=0;napi_get_value_string_utf8(env,result,nullptr,0,&size);if(size<8192){std::string json(size+1,'\0');napi_get_value_string_utf8(env,result,json.data(),json.size(),&size);id value=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json.data()length:size] options:0 error:nil];if([value isKindOfClass:NSDictionary.class])w->params=value;}}
  }
  napi_create_promise(env,&w->deferred,&promise);napi_value name;napi_create_string_utf8(env,"BOPER control",NAPI_AUTO_LENGTH,&name);napi_create_async_work(env,nullptr,name,perform,complete,w,&w->work);napi_queue_async_work(env,w->work);return promise;
}
static napi_value initialize(napi_env env,napi_value exports){for(const char *name:{"status","refresh","register","unregister","unregisterLegacyService","openSettings","authorizeRuntime","renewSession","revokeSession","recover"}){napi_value function;napi_create_function(env,name,NAPI_AUTO_LENGTH,invoke,(void *)name,&function);napi_set_named_property(env,exports,name,function);}return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,initialize)
