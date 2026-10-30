// macOS 13 baseline: one recognition per explicit recording, never a restart loop.
import Foundation
import Speech
import AVFoundation
let args = CommandLine.arguments
func value(_ name: String, _ fallback: String) -> String { if let i = args.firstIndex(of:name), i+1 < args.count { return args[i+1] }; return fallback }
let outputLock = NSLock()
func emit(_ d:[String:Any]) { outputLock.lock(); defer { outputLock.unlock() }; if let d=try? JSONSerialization.data(withJSONObject:d), let s=String(data:d,encoding:.utf8) { print(s); fflush(stdout) } }
let engine=AVAudioEngine()
let recognizer=SFSpeechRecognizer(locale:Locale(identifier:value("--lang",Locale.current.identifier)))
let lock=NSLock()
var task:SFSpeechRecognitionTask?, request:SFSpeechAudioBufferRecognitionRequest?
var ended=false, text="", tapped=false, muted=false, count=0
func finish(_ commit:Bool) {
    lock.lock(); if ended {lock.unlock();return};ended=true;let final=text;lock.unlock()
    engine.stop(); if tapped { engine.inputNode.removeTap(onBus:0); tapped=false };request?.endAudio();task?.cancel()
    if commit {emit(["t":"final","v":final])};emit(["t":"end"])
    DispatchQueue.main.asyncAfter(deadline:.now()+0.05) {exit(0)}
}
func status() -> [String:Any] {
    ["t":"auth","speech":SFSpeechRecognizer.authorizationStatus().rawValue,
     "mic":AVCaptureDevice.authorizationStatus(for:.audio) == .authorized,
     "engine":"SFSpeechRecognizer","mode":"single","available":recognizer?.isAvailable == true,
     "onDevice":recognizer?.supportsOnDeviceRecognition == true]
}
func run() {
    emit(status())
    if args.contains("--status") {emit(["t":"end"]);exit(0)}
    guard AVCaptureDevice.authorizationStatus(for:.audio) == .authorized,
          SFSpeechRecognizer.authorizationStatus() == .authorized,
          let r=recognizer, r.isAvailable else {emit(["t":"error","v":"请允许麦克风/语音识别，并检查系统听写或网络","code":4]);finish(false);return}
    if !r.supportsOnDeviceRecognition && !args.contains("--allow-network") {emit(["t":"error","v":"该语言需联网识别；请在听力设置中允许，或使用文字输入","code":23]);finish(false);return}
    let req=SFSpeechAudioBufferRecognitionRequest();request=req;req.shouldReportPartialResults=true
    req.requiresOnDeviceRecognition=r.supportsOnDeviceRecognition
    task=r.recognitionTask(with:req) {result,error in
        if let result {lock.lock();text=result.bestTranscription.formattedString;lock.unlock();emit(["t":"partial","v":result.bestTranscription.formattedString]);if result.isFinal {finish(true)}}
        else if error != nil {emit(["t":"error","v":"系统识别暂不可用，请检查听写和网络后重试","code":6]);finish(false)}
    }
    let node=engine.inputNode,format=node.outputFormat(forBus:0)
    guard format.sampleRate>0,format.channelCount>0 else {finish(false);return}
    node.installTap(onBus:0,bufferSize:4096,format:format) {buffer,_ in
        lock.lock();let skip=muted;count+=1;let n=count;lock.unlock()
        if !skip { req.append(buffer) }
        if n == 1 {emit(["t":"ready","captureHeartbeat":true]);emit(["t":"aec","on":false])}
        if n % 10 == 0 {emit(["t":"capture","buffers":n])}
        if n % 3 == 0, let channel=buffer.floatChannelData?[0] { var sum:Float=0;for i in 0..<Int(buffer.frameLength) {sum+=channel[i]*channel[i]};emit(["t":"level","v":Double(min(1,sqrt(sum/Float(max(1,buffer.frameLength)))*6))]) }
    };tapped=true
    do {engine.prepare();try engine.start()}catch {emit(["t":"error","v":"无法连接麦克风","code":6]);finish(false)}
    DispatchQueue.main.asyncAfter(deadline:.now()+45) {finish(true)}
}
if args.contains("--ask-speech") {
    SFSpeechRecognizer.requestAuthorization {_ in DispatchQueue.main.async { run() }}
} else {DispatchQueue.main.async {run()}}
if !args.contains("--status") { DispatchQueue.global().async {
    while let command=readLine() {
        if command == "quit" {finish(false);return}
        if command == "stop" { DispatchQueue.main.async { engine.stop(); if tapped { engine.inputNode.removeTap(onBus:0); tapped=false }; request?.endAudio();DispatchQueue.main.asyncAfter(deadline:.now()+1) {finish(true)} };return }
        lock.lock();if command == "mute" {muted=true};if command == "unmute" {muted=false};lock.unlock()
    };finish(false)
} }
let parent=getppid()
Timer.scheduledTimer(withTimeInterval:2,repeats:true) {_ in if getppid() != parent || parent == 1 {finish(false)}}
RunLoop.main.run()
