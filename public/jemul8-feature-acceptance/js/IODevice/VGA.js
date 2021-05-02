/**
 * jemul8 - JavaScript x86 Emulator
 * http://jemul8.com/
 *
 * Copyright 2013 jemul8.com (http://github.com/asmblah/jemul8)
 * Released under the MIT license
 * http://jemul8.com/MIT-LICENSE.txt
 */

/*
 * VGA (Video Graphics Adapter) chip
 */

/*global define */
define([
    "js/util",
    "js/IODevice",
    "js/core/classes/iodev/vga",
    "js/Promise"
], function (
    util,
    IODevice,
    LegacyVGA,
    Promise
) {
    "use strict";

    var BIOS_ROM_OPTION = "bios";

    function VGA(system, io, memory, options) {
        IODevice.call(this, "VGA", system, io, memory, options);

        this.legacyMemoryReadHandler = null;
        this.legacyMemoryWriteHandler = null;
        this.legacyReadHandler = null;
        this.legacyWriteHandler = null;

        this.legacyVGA = new LegacyVGA((function (vga) {
            return {
                cmos: {
                    installEquipment: function () {}
                },
                emu: {
                    getSetting: function (name) {
                        if (name === "vga.bios") {
                            return vga.options[BIOS_ROM_OPTION];
                        }

                        throw new Error("Unknown");
                    }
                },
                getTimeUsecs: function () {
                    return Date.now() * 1000;
                },
                io: {
                    registerIO_Read: function (device, addr, name, fn) {
                        vga.legacyReadHandler = fn;
                    },
                    registerIO_Write: function (device, addr, name, fn) {
                        vga.legacyWriteHandler = fn;
                    }
                },
                mem: {
                    loadROM: function (buffer, address) {
                        vga.system.write({
                            data: buffer,
                            to: address
                        });
                    },
                    registerMemoryHandlers: function (addrBegin, addrEnd, fnRead, fnWrite) {
                        vga.legacyMemoryReadHandler = fnRead;
                        vga.legacyMemoryWriteHandler = fnWrite;
                    }
                },
                registerTimer: function (fn, thisObj, interval) {
                    var timer = system.createTimer();

                    timer.on("elapse", function () {
                        fn.call(thisObj, Date.now());
                        timer.triggerAfterMicroseconds(interval);
                    });

                    timer.triggerAfterMicroseconds(interval);
                }
            };
        }(this)));
    }

    util.inherit(VGA).from(IODevice);

    util.extend(VGA.prototype, {
        getIOPorts: function () {
            var description = "VGA",
                port,
                ports = {};

            for (port = 0x03B4 ; port <= 0x03B5; ++port) {
                ports[port] = { description: description, allowedIOLengths: {1: true, 2: true} };
            }

            for (port = 0x03BA ; port <= 0x03BA ; ++port) {
                ports[port] = { description: description, allowedIOLengths: {1: true, 2: true} };
            }

            for (port = 0x03C0 ; port <= 0x03CF ; ++port) {
                ports[port] = { description: description, allowedIOLengths: {1: true, 2: true} };
            }

            for (port = 0x03D4 ; port <= 0x03D5 ; ++port) {
                ports[port] = { description: description, allowedIOLengths: {1: true, 2: true} };
            }

            for (port = 0x03DA ; port <= 0x03DA ; ++port) {
                ports[port] = { description: description, allowedIOLengths: {1: true, 2: true} };
            }

            return ports;
        },

        getPluginData: function () {
            return this.legacyVGA;
        },

        init: function () {
            var vga = this,
                promise = new Promise();

            vga.legacyVGA.init(function () {
                promise.resolve();
            }, function () {
                promise.reject();
            });

            return promise;
        },

        ioRead: function (port, length) {
            var vga = this;

            return vga.legacyReadHandler(vga.legacyVGA, port, length);
        },

        ioWrite: function (port, value, length) {
            var vga = this;

            vga.legacyWriteHandler(vga.legacyVGA, port, value, length);
        },

        memoryRead: function (a20Address, length) {
            var vga = this;

            return vga.legacyMemoryReadHandler(a20Address, length, vga.legacyVGA);
        },

        memoryWrite: function (a20Address, value, length) {
            var vga = this;

            return vga.legacyMemoryWriteHandler(a20Address, value, length, vga.legacyVGA);
        },

        reset: function () {
            var vga = this;

            return vga;
        }
    });

    return VGA;
});
