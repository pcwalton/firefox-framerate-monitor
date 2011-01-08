//
// firefox-framerate-monitor/lib/shark.js
//
// Copyright (c) 2010 Mozilla Foundation
// Patrick Walton <pcwalton@mozilla.com>
//

let { Cu } = require('chrome');

let ctypes;

const SHARK_MSG_ACQUIRE     = 0x29a;
const SHARK_MSG_RELEASE     = 0x29b;
const SHARK_MSG_STOP        = 0x29c;
const SHARK_MSG_START       = 0x29d;

const MACH_SEND_MSG         = 0x1;
const MACH_RCV_MSG          = 0x2;

const TASK_BOOTSTRAP_PORT   = 0x4;

function Shark() {
    let imports = {};
    Cu.import("resource://gre/modules/ctypes.jsm", imports);
    ctypes = imports.ctypes;

    this.libSystem = ctypes.open("libSystem.dylib");

    this.mach_port_t = ctypes.uint32_t;

    this.mach_msg_header_t = new ctypes.StructType(
        'mach_msg_header_t',
        [
            { msgh_bits:        ctypes.uint32_t     },
            { msgh_size:        ctypes.uint32_t     },
            { msgh_remote_port: this.mach_port_t    },
            { msgh_local_port:  this.mach_port_t    },
            { msgh_reserved:    ctypes.uint32_t     },
            { msgh_id:          ctypes.uint32_t     }
        ]);

    this.chud_client_acquire_msg = new ctypes.StructType(
        'chud_client_acquire_msg',
        [
            { hdr:  this.mach_msg_header_t                      },
            { unk0: ctypes.uint32_t                             },
            { unk1: ctypes.uint32_t                             },
            { pid:  ctypes.uint32_t                             },
            { out:  new ctypes.ArrayType(ctypes.uint32_t, 2)    }
        ]);

    this.chud_client_start_msg = new ctypes.StructType(
        'chud_client_start_msg',
        [
            { hdr:      this.mach_msg_header_t  },
            { unk0:     ctypes.uint32_t         },
            { name0:    ctypes.uint32_t         },
            { arg2:     ctypes.uint32_t         },
            { unk1:     ctypes.uint8_t          },
            { unk2:     ctypes.uint8_t          },
            { unk3:     ctypes.uint8_t          },
            { unk4:     ctypes.uint8_t          },
            { unk5:     ctypes.uint32_t         },
            { unk6:     ctypes.uint32_t         },
            { name1:    ctypes.uint32_t         }
        ]);

    this.chud_client_stop_msg = new ctypes.StructType(
        'chud_client_stop_msg',
        [
            { hdr:      this.mach_msg_header_t                      },
            { out:      new ctypes.ArrayType(ctypes.uint32_t, 5)    }
        ]);

    this.chud_client_release_msg = new ctypes.StructType(
        'chud_client_release_msg',
        [
            { hdr:  this.mach_msg_header_t                      },
            { unk0: ctypes.uint32_t                             },
            { unk1: ctypes.uint32_t                             },
            { pid:  ctypes.uint32_t                             },
            { out:  new ctypes.ArrayType(ctypes.uint32_t, 2)    }
        ]);

    this.bootstrap_look_up = this.libSystem.declare(
        'bootstrap_look_up',
        ctypes.default_abi,
        ctypes.uint32_t,
        this.mach_port_t,                           // mach_port_t special_port
        new ctypes.PointerType(ctypes.char),        // const char *name
        new ctypes.PointerType(this.mach_port_t));  // mach_port_t *dest_port

    this.task_get_special_port = this.libSystem.declare(
        'task_get_special_port',
        ctypes.default_abi,
        ctypes.uint32_t,
        ctypes.voidptr_t,                           // task_t task
        ctypes.uint32_t,                            // port_type
        new ctypes.PointerType(this.mach_port_t));  // mach_port_t *dest_port

    this.mig_get_reply_port = this.libSystem.declare(
        'mig_get_reply_port',
        ctypes.default_abi,
        this.mach_port_t);

    this.mig_dealloc_reply_port = this.libSystem.declare(
        'mig_dealloc_reply_port',
        ctypes.default_abi,
        ctypes.uint32_t,
        this.mach_port_t);

    this.mach_msg = this.libSystem.declare(
        'mach_msg',
        ctypes.default_abi,
        ctypes.uint32_t,
        new ctypes.PointerType(this.mach_msg_header_t),
        ctypes.uint32_t,
        ctypes.uint32_t,
        ctypes.uint32_t,
        this.mach_port_t,
        ctypes.uint32_t,
        ctypes.uint32_t);

    this.getpid = this.libSystem.declare(
        'getpid',
        ctypes.default_abi,
        ctypes.uint32_t);

    this.mach_task_self = this.libSystem.declare(
        'mach_task_self',
        ctypes.default_abi,
        ctypes.voidptr_t);
}

Shark.prototype = {
    _createSharkPort: function() {
        let bootstrapPort = new this.mach_port_t;
        this.task_get_special_port(this.mach_task_self(), TASK_BOOTSTRAP_PORT,
                                   bootstrapPort.address());
        this._sharkPort = new this.mach_port_t(0);
        this.bootstrap_look_up(bootstrapPort, "CHUD_IPC",
                               this._sharkPort.address());
    },

    _connect: function() {
        let replyPort = this.mig_get_reply_port();
        try {
            let msg = new this.chud_client_acquire_msg;
            msg.hdr.msgh_bits = 0x1513;
            msg.hdr.msgh_size = msg.hdr.constructor.size;
            msg.hdr.msgh_remote_port = this._sharkPort;
            msg.hdr.msgh_local_port = replyPort;
            msg.hdr.msgh_reserved = 0;
            msg.hdr.msgh_id = SHARK_MSG_ACQUIRE;
            msg.unk0 = 0;
            msg.unk1 = 1;
            msg.pid = this.getpid();

            let result = this.mach_msg(msg.hdr.address(),
                                       MACH_SEND_MSG | MACH_RCV_MSG, 0x24,
                                       0x2c, replyPort, 0, 0);
            if (result)
                throw new Error("_connect failed: " + result);
        } finally {
            this.mig_dealloc_reply_port(replyPort);
        }
    },

    _start: function() {
        let replyPort = this.mig_get_reply_port();
        try {
            let msg = new this.chud_client_start_msg;
            msg.hdr.msgh_bits = 0x80001513;
            msg.hdr.msgh_size = msg.hdr.constructor.size;
            msg.hdr.msgh_remote_port = this._sharkPort;
            msg.hdr.msgh_local_port = replyPort;
            msg.hdr.msgh_reserved = 0;
            msg.hdr.msgh_id = SHARK_MSG_START;
            msg.unk0 = 1;
            msg.name0 = 0xdeadbeef;
            msg.arg2 = 6;
            msg.unk1 = 0;
            msg.unk2 = 1;
            msg.unk3 = 0;
            msg.unk4 = 1;
            msg.unk5 = 0;
            msg.unk6 = 1;
            msg.name1 = 0xdeadbeef;

            let result = this.mach_msg(msg.hdr.address(),
                                       MACH_SEND_MSG | MACH_RCV_MSG, 0x34,
                                       0x30, replyPort, 0, 0);
        } finally {
            this.mig_dealloc_reply_port(replyPort);
        }
    },

    _stop: function() { 
        let replyPort = this.mig_get_reply_port();
        try {
            let msg = new this.chud_client_stop_msg;
            msg.hdr.msgh_bits = 0x1513;
            msg.hdr.msgh_size = msg.hdr.constructor.size;
            msg.hdr.msgh_remote_port = this._sharkPort;
            msg.hdr.msgh_local_port = replyPort;
            msg.hdr.msgh_reserved = 0;
            msg.hdr.msgh_id = SHARK_MSG_STOP;

            let result = this.mach_msg(msg.hdr.address(),
                                       MACH_SEND_MSG | MACH_RCV_MSG, 0x18,
                                       0x2c, replyPort, 0, 0);
        } finally {
            this.mig_dealloc_reply_port(replyPort);
        }
    },

    _disconnect: function() {
        let replyPort = this.mig_get_reply_port();
        try {
            let msg = new this.chud_client_release_msg;
            msg.hdr.msgh_bits = 0x1513;
            msg.hdr.msgh_size = msg.hdr.constructor.size;
            msg.hdr.msgh_remote_port = this._sharkPort;
            msg.hdr.msgh_local_port = replyPort;
            msg.hdr.msgh_reserved = 0;
            msg.hdr.msgh_id = SHARK_MSG_RELEASE;
            msg.unk0 = 0;
            msg.unk1 = 1;
            msg.pid = this.getpid();

            let result = this.mach_msg(msg.hdr.address(),
                                       MACH_SEND_MSG | MACH_RCV_MSG, 0x24,
                                       0x2c, replyPort, 0, 0);
        } finally {
            this.mig_dealloc_reply_port(replyPort);
        }
    },

    start: function() {
        this._createSharkPort();
        this._connect();
        this._start();
    },

    stop: function() {
        this._stop();
        this._disconnect();
    }
};

exports.Shark = Shark;

