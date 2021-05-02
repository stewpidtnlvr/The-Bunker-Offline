/**
 * jemul8 - JavaScript x86 Emulator
 * http://jemul8.com/
 *
 * Copyright 2013 jemul8.com (http://github.com/asmblah/jemul8)
 * Released under the MIT license
 * http://jemul8.com/MIT-LICENSE.txt
 */

/*global define */
define([
    "js/util"
], function (
    util
) {
    "use strict";

    var slice = [].slice;

    function EventEmitter() {
        this.listeners = {};
    }

    util.extend(EventEmitter.prototype, {
        emit: function (eventName, arg1, arg2, arg3) {
            var eventEmitter = this,
                i,
                length,
                listeners = eventEmitter.listeners[eventName];

            if (listeners) {
                for (i = 0, length = listeners.length; i < length; i++) {
                    listeners[i].callback.call(eventEmitter, arg1, arg2, arg3);
                }
            }

            return eventEmitter;
        },

        off: function (eventName, filter, callback) {
            var eventEmitter = this,
                listeners = eventEmitter.listeners[eventName];

            if (util.isFunction(filter)) {
                callback = filter;
                filter = null;
            }

            if (listeners) {
                util.each(listeners, function (listener, index) {
                    if (listener.callback === callback && listener.filter === filter) {
                        listeners.splice(index, 1);
                        return false;
                    }
                });
            }

            return eventEmitter;
        },

        on: function (eventName, filter, callback) {
            var eventEmitter = this;

            if (!eventEmitter.listeners[eventName]) {
                eventEmitter.listeners[eventName] = [];
            }

            if (util.isFunction(filter)) {
                callback = filter;
                filter = null;
            }

            if (filter) {
                callback = (function (callback) {
                    return function () {
                        var actualArgs = slice.call(arguments),
                            match = true;

                        util.each(filter, function (expectedArg, index) {
                            if (actualArgs[index] !== expectedArg) {
                                match = false;
                                return false;
                            }
                        });

                        if (match) {
                            callback.apply(eventEmitter, actualArgs.slice(filter.length));
                        }
                    };
                }(callback));
            }

            eventEmitter.listeners[eventName].push({
                callback: callback,
                filter: filter
            });

            return eventEmitter;
        },

        one: function (eventName, filter, callback) {
            var eventEmitter = this;

            return eventEmitter.on(eventName, filter, function proxy() {
                eventEmitter.off(eventName, filter, proxy);

                callback.apply(this, arguments);
            });
        }
    });

    return EventEmitter;
});
