#!/usr/bin/env python3
"""在 A1X 上执行 bash 脚本。用法：
  A1X_HOST=192.168.1.10 A1X_USER=AOKZOE A1X_PASS=*** tools/a1x_ssh.py <<'SH'
  hostname
  SH

payload 走 base64，绕开 expect/Tcl 对方括号与 $ 的替换。

凭据一律走环境变量，**不要写进文件**（这个仓库是公开的）。
"""
import base64
import os
import subprocess
import sys

HOST = os.environ.get("A1X_HOST", "")
USER = os.environ.get("A1X_USER", "AOKZOE")
PASSWORD = os.environ.get("A1X_PASS", "")

if not HOST or not PASSWORD:
    sys.exit("请先设置 A1X_HOST / A1X_PASS（可选 A1X_USER）环境变量")

payload = sys.stdin.read()
b64 = base64.b64encode(payload.encode()).decode()

remote = "echo %s | base64 -d | bash" % b64

expect = r"""
set timeout 120
log_user 0
spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o NumberOfPasswordPrompts=1 -o PubkeyAuthentication=no -o PreferredAuthentications=password \
    %s@%s "echo %s | base64 -d | bash"
expect {
  -re "(?i)password:" { after 1200; send -- "%s\r"; log_user 1 }
  timeout { puts "__TIMEOUT__"; exit 2 }
}
expect eof
""" % (USER, HOST, b64, PASSWORD)

r = subprocess.run(["expect", "-c", expect], capture_output=True, text=True)
print(r.stdout[-8000:])
if r.stderr.strip():
    print("[stderr]", r.stderr[-2000:], file=sys.stderr)
