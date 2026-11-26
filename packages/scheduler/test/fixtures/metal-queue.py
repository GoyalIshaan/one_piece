"""Allocate an empty Metal command queue without loading a model or encoding work."""
import ctypes
import sys

metal = ctypes.CDLL("/System/Library/Frameworks/Metal.framework/Metal")
objc = ctypes.CDLL("/usr/lib/libobjc.A.dylib")
metal.MTLCreateSystemDefaultDevice.restype = ctypes.c_void_p
objc.sel_registerName.argtypes = [ctypes.c_char_p]
objc.sel_registerName.restype = ctypes.c_void_p
objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
objc.objc_msgSend.restype = ctypes.c_void_p

device = metal.MTLCreateSystemDefaultDevice()
queue = device and objc.objc_msgSend(device, objc.sel_registerName(b"newCommandQueue"))
sys.exit(0 if queue else 3)
