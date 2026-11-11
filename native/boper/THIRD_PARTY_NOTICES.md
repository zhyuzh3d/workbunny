# BOPER third-party sources

BOPER directly compiles the Karabiner DriverKit VirtualHIDDevice C++ client. It
does not execute the old keymouse/kmbridge public socket service. Device output
is still software-generated virtual HID input; no claim of undetectability or
physical-hardware identity is made.

The source is pinned to `pqrs-org/Karabiner-DriverKit-VirtualHIDDevice` tag
`v8.8.0`, commit `212a0f660702e33a3874895c4db991061e68e0e2`. The vendored
dependency snapshot came from that commit's checked-in `vendor/vendor` tree;
its CPM lock submodule commit is `2e9a019e3da2fa530096b75cbebd3b9d674d4d8e`.
The full upstream dependency versions and repositories are retained in
`vendor/dependencies/package-lock.cmake`. Normal builds use these local sources
and perform no dependency downloads.

| Component | Version | License / retained notice |
| --- | --- | --- |
| Karabiner DriverKit client and protocol | 8.8.0; client protocol 7 | Header-level Boost Software License 1.0 notices; upstream root Unlicense in `vendor/karabiner/LICENSE.md` |
| Asio | 1.39.0 | Boost Software License 1.0, `vendor/licenses/Boost-1.0.txt`; copyright notices retained in headers |
| Microsoft GSL | 5.0.1 | MIT, `vendor/licenses/GSL-5.0.1.txt` |
| type_safe | 0.2.4 | MIT, `vendor/licenses/TypeSafe-0.2.4.txt` |
| debug_assert | 1.3.4 | zlib, `vendor/licenses/DebugAssert-1.3.4.txt` |
| nod | 0.5.4 | MIT, `vendor/licenses/Nod-0.5.4.txt` |
| nlohmann/json (upstream dependency snapshot) | 3.12.0 | MIT, `vendor/licenses/NlohmannJson-3.12.0.txt` |
| spdlog/fmt (upstream dependency snapshot) | 1.17.0 | MIT, `vendor/licenses/Spdlog-1.17.0.txt`; embedded fmt license retained in headers |
| Boost.UT (upstream dependency snapshot) | 2.3.1 | Boost Software License 1.0, `vendor/licenses/Boost-1.0.txt` |
| pqrs C++ utilities | Versions in lock file | Boost Software License 1.0; source copyright notices retained |

The BOPER-specific modification to the upstream `client.hpp` adds
`boper_post_report` and `boper_request`. It checks authority at the library
dispatcher boundary and reports daemon receipt through a completion callback.
BOPER permits one outstanding request, rather than filling the upstream async
queue with an entire movement or text sequence. A daemon receipt does not prove
driver output, target application processing, or completion of a user task.

The official driver installer is a separately signed, unchanged vendor package
managed by the application installer. Client protocol, driver readiness and
daemon connectivity are checked separately. An installed 8.5 daemon must not be
assumed compatible with client protocol 7 based on a similar product name.
