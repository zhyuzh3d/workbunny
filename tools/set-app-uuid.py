#!/usr/bin/env python3
"""Give the copied Electron executable its own reproducible application UUID.

Apple TN3179: sharing a main executable UUID with other programs can break local
network privacy. Run before codesigning; leave the fixed signing identity intact.
"""
import pathlib
import struct
import sys
import uuid

binary = pathlib.Path(sys.argv[1])
bundle = sys.argv[2]
data = bytearray(binary.read_bytes())
if struct.unpack_from('<I', data)[0] != 0xFEEDFACF:
    raise SystemExit('Expected a thin 64-bit Mach-O executable')
count, command_bytes = struct.unpack_from('<II', data, 16)
offset = 32
for _ in range(count):
    command, size = struct.unpack_from('<II', data, offset)
    if size < 8 or offset + size > 32 + command_bytes:
        raise SystemExit('Invalid Mach-O load command')
    if command == 0x1B:  # LC_UUID
        if size != 24:
            raise SystemExit('Invalid LC_UUID')
        original = uuid.UUID(bytes=bytes(data[offset + 8:offset + 24]))
        own = uuid.uuid5(uuid.NAMESPACE_DNS, bundle + ':' + str(original))
        data[offset + 8:offset + 24] = own.bytes
        binary.write_bytes(data)
        print('  Application UUID:', own)
        break
    offset += size
else:
    raise SystemExit('Main executable has no LC_UUID')
