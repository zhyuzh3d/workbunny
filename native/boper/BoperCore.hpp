#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace boper {
constexpr unsigned protocolVersion = 1;
constexpr unsigned maxLeaseMs = 3000;
constexpr unsigned maxReports = 20000;
constexpr unsigned reportIntervalMs = 8;
// Used under the helper's authority mutex. Only authenticated host messages
// participate; status polling cannot start an exit while its connection lives.
class IdleExitGate {
  std::set<uintptr_t> hosts;
  bool seenHost=false, exiting=false;
  uint64_t departed=0;
public:
  bool arrived(uintptr_t id) {if(exiting)return false;hosts.insert(id);seenHost=true;departed=0;return true;}
  void left(uintptr_t id,uint64_t now) {if(hosts.erase(id)&&hosts.empty())departed=now;}
  bool begin(uint64_t now,bool active,bool transition) {
    if(exiting||!seenHost||!hosts.empty()||active||transition||!departed||now-departed<100000000)return false;
    exiting=true;return true;
  }
  bool closing()const{return exiting;}
};
struct Failure : std::runtime_error {
  std::string code;
  Failure(std::string c, std::string message) : std::runtime_error(message), code(std::move(c)) {}
};
struct KeyboardState { uint8_t modifiers = 0; std::set<uint16_t> keys; };
struct PointerState { uint8_t buttons = 0; };
struct DesktopPoint { double x = 0, y = 0; };
struct WheelStep { int vertical = 0, horizontal = 0; };
// The tool's wheel signs describe semantic scrolling, not raw device motion.
// macOS applies its natural-scroll preference to both HID wheel axes. Cancel
// that inversion here so the same requested sign keeps the same meaning.
inline WheelStep hidWheelStep(int vertical, int horizontal, bool naturalScrolling) {
  return naturalScrolling ? WheelStep{-vertical, -horizontal} : WheelStep{vertical, horizontal};
}
struct DesktopRect {
  double x, y, width, height;
  bool contains(DesktopPoint p) const { return std::isfinite(p.x) && std::isfinite(p.y) && p.x >= x && p.y >= y && p.x < x + width && p.y < y + height; }
};
inline unsigned lease(unsigned ms) {
  if (ms < 250 || ms > maxLeaseMs) throw Failure("E_LEASE_RANGE", "leaseMs must be 250..3000");
  return ms;
}
// Deterministic minimum-jerk trajectory. Samples are evaluated at actual elapsed
// time, never replayed to catch up after a stalled scheduler.
inline DesktopPoint trajectory(DesktopPoint from, DesktopPoint to, double progress) {
  double t = std::clamp(progress, 0., 1.);
  double s = t * t * t * (10 + t * (-15 + 6 * t));
  return {from.x + (to.x - from.x) * s, from.y + (to.y - from.y) * s};
}
inline unsigned movementDuration(DesktopPoint a, DesktopPoint b) {
  double distance = std::hypot(a.x - b.x, a.y - b.y);
  return static_cast<unsigned>(std::clamp(70. + 90. * std::log2(1. + distance / 25.), 70., 1100.));
}
struct Key { uint16_t usage; uint16_t cgCode; uint8_t modifier; };
inline std::string lower(std::string s) { for (auto &c : s) c = static_cast<char>(::tolower(c)); return s; }
inline Key key(std::string name) {
  name = lower(name);
  static const std::array<uint16_t, 26> codes = {0,11,8,2,14,3,5,4,34,38,40,37,46,45,31,35,12,15,1,17,32,9,13,7,16,6};
  if (name.size() == 1 && name[0] >= 'a' && name[0] <= 'z') return {static_cast<uint16_t>(4 + name[0] - 'a'), codes[name[0] - 'a'], 0};
  static const std::array<uint16_t, 10> digits = {29,18,19,20,21,23,22,26,28,25};
  if (name.size() == 1 && name[0] >= '0' && name[0] <= '9') return {static_cast<uint16_t>(name[0] == '0' ? 39 : 29 + name[0] - '0'), digits[name[0] - '0'], 0};
  struct Entry { const char *name; Key k; };
  static const Entry entries[] = {
    {"enter",{40,36,0}}, {"return",{40,36,0}}, {"escape",{41,53,0}}, {"esc",{41,53,0}},
    {"backspace",{42,51,0}}, {"delete",{42,51,0}}, {"forwarddelete",{76,117,0}}, {"tab",{43,48,0}}, {"space",{44,49,0}},
    {"-",{45,27,0}}, {"=",{46,24,0}}, {"[",{47,33,0}}, {"]",{48,30,0}}, {"\\",{49,42,0}},
    {";",{51,41,0}}, {"'",{52,39,0}}, {"`",{53,50,0}}, {",",{54,43,0}}, {".",{55,47,0}}, {"/",{56,44,0}},
    {"right",{79,124,0}}, {"left",{80,123,0}}, {"down",{81,125,0}}, {"up",{82,126,0}},
    {"home",{74,115,0}}, {"end",{77,119,0}}, {"pageup",{75,116,0}}, {"pagedown",{78,121,0}},
    {"ctrl",{224,59,1}}, {"control",{224,59,1}}, {"shift",{225,56,2}},
    {"alt",{226,58,4}}, {"option",{226,58,4}}, {"cmd",{227,55,8}}, {"command",{227,55,8}}, {"meta",{227,55,8}},
    {"rightcontrol",{228,62,16}}, {"rightshift",{229,60,32}}, {"rightoption",{230,61,64}}, {"rightcommand",{231,54,128}}
  };
  for (const auto &e : entries) if (name == e.name) return e.k;
  static const uint16_t functionCodes[] = {122,120,99,118,96,97,98,100,101,109,103,111};
  if (name.size() >= 2 && name[0] == 'f') {
    char *end = nullptr; long n = strtol(name.c_str() + 1, &end, 10);
    if (end && !*end && n >= 1 && n <= 12) return {static_cast<uint16_t>(57+n),functionCodes[n-1],0};
  }
  throw Failure("E_UNSUPPORTED_KEY", "Unsupported key name");
}
inline uint8_t button(std::string value) {
  value = lower(value);
  if (value.empty() || value == "left" || value == "0") return 1;
  if (value == "right" || value == "1") return 2;
  if (value == "middle" || value == "2") return 4;
  throw Failure("E_UNSUPPORTED_BUTTON", "button must be left, right or middle");
}
} // namespace boper
