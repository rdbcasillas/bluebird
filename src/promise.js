"use strict";
module.exports = function() {
var makeSelfResolutionError = function () {
    return new TypeError(CIRCULAR_RESOLUTION_ERROR);
};
var reflect = function() {
    return new Promise.PromiseInspection(this);
};
var returnFirstElement = function(elements) { return elements[0]; };
var ASSERT = require("./assert.js");
var util = require("./util.js");
var async = require("./async.js");
var errors = require("./errors.js");
var INTERNAL = function(){};
var APPLY = {};
var NEXT_FILTER = {e: null};
var tryConvertToPromise = require("./thenables.js")(Promise, INTERNAL);
var PromiseArray =
    require("./promise_array.js")(Promise, INTERNAL, tryConvertToPromise);
var CapturedTrace = require("./captured_trace.js")();
var CatchFilter = require("./catch_filter.js")(NEXT_FILTER);
var PromiseResolver = require("./promise_resolver.js");
var isArray = util.isArray;
var errorObj = util.errorObj;
var tryCatch1 = util.tryCatch1;
var tryCatch2 = util.tryCatch2;
var tryCatchApply = util.tryCatchApply;
var RangeError = errors.RangeError;
var TypeError = errors.TypeError;
var CancellationError = errors.CancellationError;
var TimeoutError = errors.TimeoutError;
var OperationalError = errors.OperationalError;
var originatesFromRejection = errors.originatesFromRejection;
var markAsOriginatingFromRejection = errors.markAsOriginatingFromRejection;
var canAttachTrace = errors.canAttachTrace;
var apiRejection = require("./errors_api_rejection")(Promise);
var unhandledRejectionHandled;
var debugging = __DEBUG__ || !!(
    typeof process !== "undefined" &&
    typeof process.execPath === "string" &&
    typeof process.env === "object" &&
    (process.env["BLUEBIRD_DEBUG"] ||
        process.env["NODE_ENV"] === "development")
);

function Promise(resolver) {
    if (typeof resolver !== "function") {
        throw new TypeError(CONSTRUCT_ERROR_ARG);
    }
    if (this.constructor !== Promise) {
        throw new TypeError(CONSTRUCT_ERROR_INVOCATION);
    }
    //see constants.js for layout
    this._bitField = NO_STATE;
    //Since most promises have exactly 1 parallel handler
    //store the first ones directly on the object
    //The rest (if needed) are stored on the object's
    //elements array (this[0], this[1]...etc)
    //which has less indirection than when using external array
    this._fulfillmentHandler0 = undefined;
    this._rejectionHandler0 = undefined;
    this._progressHandler0 = undefined;
    this._promise0 = undefined;
    this._receiver0 = undefined;
    //reason for rejection or fulfilled value
    this._settledValue = undefined;
    //for .bind
    this._boundTo = undefined;
    if (resolver !== INTERNAL) this._resolveFromResolver(resolver);
}

Promise.prototype.bind = function (thisArg) {
    var maybePromise = tryConvertToPromise(thisArg, this);
    var ret = new Promise(INTERNAL);
    ret._propagateFrom(this, PROPAGATE_TRACE | PROPAGATE_CANCEL);
    if (maybePromise instanceof Promise) {
        var binder = maybePromise.then(function(thisArg) {
            ret._setBoundTo(thisArg);
        });
        var p = Promise.all([this, binder]).then(returnFirstElement);
        ret._follow(p);
    } else {
        ret._follow(this);
        ret._setBoundTo(thisArg);
    }

    return ret;
};

Promise.prototype.toString = function () {
    return "[object Promise]";
};

Promise.prototype.caught = Promise.prototype["catch"] = function (fn) {
    var len = arguments.length;
    if (len > 1) {
        var catchInstances = new Array(len - 1),
            j = 0, i;
        for (i = 0; i < len - 1; ++i) {
            var item = arguments[i];
            if (typeof item === "function") {
                catchInstances[j++] = item;
            } else {
                var error = new TypeError(NOT_ERROR_TYPE_OR_PREDICATE);
                this._attachExtraTrace(error);
                return Promise.reject(error);
            }
        }
        catchInstances.length = j;
        fn = arguments[i];

        this._resetTrace();
        var catchFilter = new CatchFilter(catchInstances, fn, this);
        return this._then(undefined, catchFilter.doFilter, undefined,
            catchFilter, undefined);
    }
    return this._then(undefined, fn, undefined, undefined, undefined);
};

Promise.prototype.reflect = function () {
    return this._then(reflect, reflect, undefined, this, undefined);
};

Promise.prototype.then = function (didFulfill, didReject, didProgress) {
    return this._then(didFulfill, didReject, didProgress,
        undefined, undefined);
};


Promise.prototype.done = function (didFulfill, didReject, didProgress) {
    var promise = this._then(didFulfill, didReject, didProgress,
        undefined, undefined);
    promise._setIsFinal();
};

Promise.prototype.spread = function (didFulfill, didReject) {
    return this.all()._then(didFulfill, didReject, undefined, APPLY, undefined);
};

Promise.prototype.isCancellable = function () {
    return !this.isResolved() &&
        this._cancellable();
};

Promise.prototype.toJSON = function () {
    var ret = {
        isFulfilled: false,
        isRejected: false,
        fulfillmentValue: undefined,
        rejectionReason: undefined
    };
    if (this.isFulfilled()) {
        ret.fulfillmentValue = this._settledValue;
        ret.isFulfilled = true;
    } else if (this.isRejected()) {
        ret.rejectionReason = this._settledValue;
        ret.isRejected = true;
    }
    return ret;
};

Promise.prototype.all = function () {
    return new PromiseArray(this).promise();
};

Promise.prototype.error = function (fn) {
    return this.caught(originatesFromRejection, fn);
};

Promise.is = function (val) {
    return val instanceof Promise;
};

Promise.all = function (promises) {
    return new PromiseArray(promises).promise();
};

Promise.method = function (fn) {
    if (typeof fn !== "function") {
        throw new TypeError(NOT_FUNCTION_ERROR);
    }
    return function () {
        var value;
        switch(arguments.length) {
        case 0: value = tryCatch1(fn, this, undefined); break;
        case 1: value = tryCatch1(fn, this, arguments[0]); break;
        case 2: value = tryCatch2(fn, this, arguments[0], arguments[1]); break;
        default:
            INLINE_SLICE(args, arguments);
            value = tryCatchApply(fn, args, this); break;
        }
        var ret = new Promise(INTERNAL);
        ret._setTrace(undefined);
        ret._resolveFromSyncValue(value);
        return ret;
    };
};

Promise.attempt = Promise["try"] = function (fn, args, ctx) {
    if (typeof fn !== "function") {
        return apiRejection(NOT_FUNCTION_ERROR);
    }
    var value = isArray(args)
        ? tryCatchApply(fn, args, ctx)
        : tryCatch1(fn, ctx, args);

    var ret = new Promise(INTERNAL);
    ret._setTrace(undefined);
    ret._resolveFromSyncValue(value);
    return ret;
};

Promise.defer = Promise.pending = function () {
    var promise = new Promise(INTERNAL);
    promise._setTrace(undefined);
    return new PromiseResolver(promise);
};

Promise.bind = function (thisArg) {
    var maybePromise = tryConvertToPromise(thisArg, undefined);
    var ret = new Promise(INTERNAL);
    ret._setTrace(undefined);

    if (maybePromise instanceof Promise) {
        var p = maybePromise.then(function(thisArg) {
            ret._setBoundTo(thisArg);
        });
        ret._follow(p);
    } else {
        ret._setBoundTo(thisArg);
        ret._setFulfilled();
    }
    return ret;
};

Promise.cast = function (obj) {
    var ret = tryConvertToPromise(obj, undefined);
    if (!(ret instanceof Promise)) {
        var val = ret;
        ret = new Promise(INTERNAL);
        ret._setTrace(undefined);
        ret._setFulfilled();
        ret._settledValue = val;
        ret._cleanValues();
    }
    return ret;
};

Promise.resolve = Promise.fulfilled = Promise.cast;

Promise.reject = Promise.rejected = function (reason) {
    var ret = new Promise(INTERNAL);
    ret._setTrace(undefined);
    markAsOriginatingFromRejection(reason);
    ret._setRejected();
    ret._settledValue = reason;
    ret._cleanValues();
    if (!canAttachTrace(reason)) {
        var trace = new Error(reason + "");
        ret._setCarriedStackTrace(trace);
    }
    ret._ensurePossibleRejectionHandled();
    return ret;
};

Promise.onPossiblyUnhandledRejection = function (fn) {
        CapturedTrace.possiblyUnhandledRejection = typeof fn === "function"
                                                    ? fn : undefined;
};

Promise.onUnhandledRejectionHandled = function (fn) {
    unhandledRejectionHandled = typeof fn === "function" ? fn : undefined;
};

Promise.longStackTraces = function () {
    if (async.haveItemsQueued() &&
        debugging === false
   ) {
        throw new Error(LONG_STACK_TRACES_ERROR);
    }
    debugging = CapturedTrace.isSupported();
};

Promise.hasLongStackTraces = function () {
    return debugging && CapturedTrace.isSupported();
};

Promise.setScheduler = function(fn) {
    if (typeof fn !== "function") throw new TypeError(NOT_FUNCTION_ERROR);
    async._schedule = fn;
};

Promise.prototype._then = function (
    didFulfill,
    didReject,
    didProgress,
    receiver,
    internalData
) {
    ASSERT(arguments.length === 5);
    var haveInternalData = internalData !== undefined;
    var ret = haveInternalData ? internalData : new Promise(INTERNAL);

    if (!haveInternalData) {
        ret._propagateFrom(this, PROPAGATE_ALL);
    }

    var callbackIndex =
        this._addCallbacks(didFulfill, didReject, didProgress, ret, receiver);

    if (this.isResolved() && !this._isSettlePromisesQueued()) {
        async.invoke(this._settlePromiseAtPostResolution, this, callbackIndex);
    }

    return ret;
};

Promise.prototype._settlePromiseAtPostResolution = function (index) {
    ASSERT(typeof index === "number");
    ASSERT(index >= 0);
    ASSERT(this.isFulfilled() || this.isRejected());
    ASSERT(this._promiseAt(index) !== undefined);
    if (this._isRejectionUnhandled()) this._unsetRejectionIsUnhandled();
    this._setLength(0);
    this._settlePromiseAt(index);
};

Promise.prototype._length = function () {
    ASSERT(arguments.length === 0);
    return this._bitField & LENGTH_MASK;
};

Promise.prototype._isFollowingOrFulfilledOrRejected = function () {
    return (this._bitField & IS_FOLLOWING_OR_REJECTED_OR_FULFILLED) > 0;
};

Promise.prototype._isFollowing = function () {
    return (this._bitField & IS_FOLLOWING) === IS_FOLLOWING;
};

Promise.prototype._setLength = function (len) {
    this._bitField = (this._bitField & LENGTH_CLEAR_MASK) |
        (len & LENGTH_MASK);
};

Promise.prototype._setFulfilled = function () {
    this._bitField = this._bitField | IS_FULFILLED;
};

Promise.prototype._setRejected = function () {
    this._bitField = this._bitField | IS_REJECTED;
};

Promise.prototype._setFollowing = function () {
    this._bitField = this._bitField | IS_FOLLOWING;
};

Promise.prototype._setIsFinal = function () {
    this._bitField = this._bitField | IS_FINAL;
};

Promise.prototype._isFinal = function () {
    return (this._bitField & IS_FINAL) > 0;
};

Promise.prototype._cancellable = function () {
    return (this._bitField & IS_CANCELLABLE) > 0;
};

Promise.prototype._setCancellable = function () {
    this._bitField = this._bitField | IS_CANCELLABLE;
};

Promise.prototype._unsetCancellable = function () {
    this._bitField = this._bitField & (~IS_CANCELLABLE);
};

Promise.prototype._setRejectionIsUnhandled = function () {
    ASSERT(this.isRejected());
    this._bitField = this._bitField | IS_REJECTION_UNHANDLED;
};

Promise.prototype._unsetRejectionIsUnhandled = function () {
    this._bitField = this._bitField & (~IS_REJECTION_UNHANDLED);
    if (this._isUnhandledRejectionNotified()) {
        this._unsetUnhandledRejectionIsNotified();
        this._notifyUnhandledRejectionIsHandled();
    }
};

Promise.prototype._isRejectionUnhandled = function () {
    return (this._bitField & IS_REJECTION_UNHANDLED) > 0;
};

Promise.prototype._setUnhandledRejectionIsNotified = function () {
    this._bitField = this._bitField | IS_UNHANDLED_REJECTION_NOTIFIED;
};

Promise.prototype._unsetUnhandledRejectionIsNotified = function () {
    this._bitField = this._bitField & (~IS_UNHANDLED_REJECTION_NOTIFIED);
};

Promise.prototype._isUnhandledRejectionNotified = function () {
    return (this._bitField & IS_UNHANDLED_REJECTION_NOTIFIED) > 0;
};

Promise.prototype._setCarriedStackTrace = function (capturedTrace) {
    ASSERT(this.isRejected());
    this._bitField = this._bitField | IS_CARRYING_STACK_TRACE;
    //Since this field is not used in rejected promises, smuggle the trace there
    this._fulfillmentHandler0 = capturedTrace;
};

Promise.prototype._unsetCarriedStackTrace = function () {
    ASSERT(this.isRejected());
    this._bitField = this._bitField & (~IS_CARRYING_STACK_TRACE);
    this._fulfillmentHandler0 = undefined;
};

Promise.prototype._isCarryingStackTrace = function () {
    return (this._bitField & IS_CARRYING_STACK_TRACE) > 0;
};

Promise.prototype._getCarriedStackTrace = function () {
    ASSERT(this.isRejected());
    return this._isCarryingStackTrace()
        ? this._fulfillmentHandler0
        : undefined;
};

Promise.prototype._receiverAt = function (index) {
    var ret = index === 0
        ? this._receiver0
        : this[(index << 2) + index - CALLBACK_SIZE + CALLBACK_RECEIVER_OFFSET];
    //Only use the bound value when not calling internal methods
    if (this._isBound() && ret === undefined) {
        return this._boundTo;
    }
    return ret;
};

Promise.prototype._promiseAt = function (index) {
    return index === 0
        ? this._promise0
        : this[(index << 2) + index - CALLBACK_SIZE + CALLBACK_PROMISE_OFFSET];
};

Promise.prototype._fulfillmentHandlerAt = function (index) {
    ASSERT(!this._isCarryingStackTrace());
    return index === 0
        ? this._fulfillmentHandler0
        : this[(index << 2) + index - CALLBACK_SIZE + CALLBACK_FULFILL_OFFSET];
};

Promise.prototype._rejectionHandlerAt = function (index) {
    return index === 0
        ? this._rejectionHandler0
        : this[(index << 2) + index - CALLBACK_SIZE + CALLBACK_REJECT_OFFSET];
};

Promise.prototype._addCallbacks = function (
    fulfill,
    reject,
    progress,
    promise,
    receiver
) {
    var index = this._length();

    if (index >= MAX_LENGTH - CALLBACK_SIZE) {
        index = 0;
        this._setLength(0);
    }

    if (index === 0) {
        ASSERT(this._promise0 === undefined);
        ASSERT(this._receiver0 === undefined);
        ASSERT(this._fulfillmentHandler0 === undefined ||
            this._isCarryingStackTrace());
        ASSERT(this._rejectionHandler0 === undefined);
        ASSERT(this._progressHandler0 === undefined);

        this._promise0 = promise;
        if (receiver !== undefined) this._receiver0 = receiver;
        if (typeof fulfill === "function" && !this._isCarryingStackTrace())
            this._fulfillmentHandler0 = fulfill;
        if (typeof reject === "function") this._rejectionHandler0 = reject;
        if (typeof progress === "function") this._progressHandler0 = progress;
    } else {
        ASSERT(this[base + CALLBACK_PROMISE_OFFSET] === undefined);
        ASSERT(this[base + CALLBACK_RECEIVER_OFFSET] === undefined);
        ASSERT(this[base + CALLBACK_FULFILL_OFFSET] === undefined);
        ASSERT(this[base + CALLBACK_REJECT_OFFSET] === undefined);
        ASSERT(this[base + CALLBACK_PROGRESS_OFFSET] === undefined);
        var base = index * CALLBACK_SIZE - CALLBACK_SIZE;
        this[base + CALLBACK_PROMISE_OFFSET] = promise;
        this[base + CALLBACK_RECEIVER_OFFSET] = receiver;
        if (typeof fulfill === "function")
            this[base + CALLBACK_FULFILL_OFFSET] = fulfill;
        if (typeof reject === "function")
            this[base + CALLBACK_REJECT_OFFSET] = reject;
        if (typeof progress === "function")
            this[base + CALLBACK_PROGRESS_OFFSET] = progress;
    }
    this._setLength(index + 1);
    return index;
};

Promise.prototype._setProxyHandlers = function (receiver, promiseSlotValue) {
    var index = this._length();

    if (index >= MAX_LENGTH - CALLBACK_SIZE) {
        index = 0;
        this._setLength(0);
    }
    if (index === 0) {
        this._promise0 = promiseSlotValue;
        this._receiver0 = receiver;
    } else {
        var base = index * CALLBACK_SIZE - CALLBACK_SIZE;
        this[base + CALLBACK_PROMISE_OFFSET] = promiseSlotValue;
        this[base + CALLBACK_RECEIVER_OFFSET] = receiver;
    }
    this._setLength(index + 1);
};

Promise.prototype._proxyPromiseArray = function (promiseArray, index) {
    ASSERT(!this.isResolved());
    ASSERT(arguments.length === 2);
    ASSERT(typeof index === "number");
    ASSERT((index | 0) === index);
    this._setProxyHandlers(promiseArray, index);
};

Promise.prototype._proxyPromise = function (promise) {
    ASSERT(!promise._isProxied());
    ASSERT(!this.isResolved());
    ASSERT(arguments.length === 1);
    promise._setProxied();
    this._setProxyHandlers(promise, -15);
};

Promise.prototype._setBoundTo = function (obj) {
    if (obj !== undefined) {
        this._bitField = this._bitField | IS_BOUND;
        this._boundTo = obj;
    } else {
        this._bitField = this._bitField & (~IS_BOUND);
    }
};

Promise.prototype._isBound = function () {
    return (this._bitField & IS_BOUND) === IS_BOUND;
};

Promise.prototype._resolveFromResolver = function (resolver) {
    ASSERT(typeof resolver === "function");
    var promise = this;
    this._setTrace(undefined);

    this._pushContext();
    var r = tryCatch2(resolver, undefined, function(val) {
        if (promise._tryFollow(val)) {
            return;
        }
        promise._fulfill(val);
    }, function (val) {
        var trace = canAttachTrace(val) ? val : new Error(val + "");
        promise._attachExtraTrace(trace);
        markAsOriginatingFromRejection(val);
        promise._reject(val, trace === val ? undefined : trace);
    });
    this._popContext();

    if (r !== undefined && r === errorObj) {
        var e = r.e;
        var trace = canAttachTrace(e) ? e : new Error(e + "");
        promise._reject(e, trace);
    }
};

Promise.prototype._callHandler = function (
    handler, receiver, promise, value) {
    //Special receiver that means we are .applying an array of arguments
    //(for .spread() at the moment)
    var x;
    promise._pushContext();
    if (receiver === APPLY && !this.isRejected()) {
        ASSERT(isArray(value));
        x = tryCatchApply(handler, value, this._boundTo);
    } else {
        x = tryCatch1(handler, receiver, value);
    }
    promise._popContext();
    return x;
};

Promise.prototype._settlePromiseFromHandler = function (
    handler, receiver, value, promise
) {
    if (promise.isRejected()) return;
    ASSERT(!promise._isFollowingOrFulfilledOrRejected());
    var x = this._callHandler(handler, receiver, promise, value);
    if (promise._isFollowing()) return;

    if (x === errorObj || x === promise || x === NEXT_FILTER) {
        var err = x === promise
                    ? makeSelfResolutionError()
                    : x.e;
        var trace = canAttachTrace(err) ? err : new Error(err + "");
        if (x !== NEXT_FILTER) promise._attachExtraTrace(trace);
        promise._rejectUnchecked(err, trace);
    } else {
        var castValue = tryConvertToPromise(x, promise);
        if (castValue instanceof Promise) {
            if (castValue.isRejected() &&
                !castValue._isCarryingStackTrace() &&
                !canAttachTrace(castValue._settledValue)) {
                var trace = new Error(castValue._settledValue + "");
                promise._attachExtraTrace(trace);
                castValue._setCarriedStackTrace(trace);
            }
            promise._follow(castValue);
            promise._propagateFrom(castValue, PROPAGATE_CANCEL);
        } else {
            promise._fulfillUnchecked(x);
        }
    }
};

Promise.prototype._follow = function (promise) {
    ASSERT(arguments.length === 1);
    ASSERT(this._isFollowingOrFulfilledOrRejected() === false);
    ASSERT(promise !== this);
    this._setFollowing();

    if (promise.isPending()) {
        this._propagateFrom(promise, PROPAGATE_CANCEL);
        promise._proxyPromise(this);
    } else if (promise.isFulfilled()) {
        this._fulfillUnchecked(promise._settledValue);
    } else {
        this._rejectUnchecked(promise._settledValue,
            promise._getCarriedStackTrace());
    }

    if (promise._isRejectionUnhandled()) promise._unsetRejectionIsUnhandled();

    if (debugging &&
        !promise._trace.hasParent()) {
        ASSERT(this._trace instanceof CapturedTrace);
        promise._trace.setParent(this._trace);
    }
};

Promise.prototype._tryFollow = function (value) {
    ASSERT(arguments.length === 1);
    if (this._isFollowingOrFulfilledOrRejected() ||
        value === this) {
        return false;
    }
    var maybePromise = tryConvertToPromise(value, this);
    if (!(maybePromise instanceof Promise)) {
        return false;
    }
    this._follow(maybePromise);
    return true;
};

Promise.prototype._resetTrace = function () {
    if (debugging) {
        this._trace = new CapturedTrace(this._peekContext());
    }
};

Promise.prototype._setTrace = function (parent) {
    ASSERT(this._trace == null);
    if (debugging) {
        var context = this._peekContext();
        if (parent !== undefined &&
            parent._trace.parent() === context) {
            this._trace = parent._trace;
        } else {
            this._trace = new CapturedTrace(context);
        }
    }
    return this;
};

Promise.prototype._attachExtraTrace = function (error) {
    if (debugging && canAttachTrace(error)) {
        this._trace.attachExtraTrace(error);
    }
};

Promise.prototype._cleanValues = function () {
    if (this._cancellable()) {
        this._cancellationParent = undefined;
    }
};

Promise.prototype._propagateFrom = function (parent, flags) {
    if ((flags & PROPAGATE_CANCEL) > 0 && parent._cancellable()) {
        this._setCancellable();
        this._cancellationParent = parent;
    }
    if ((flags & PROPAGATE_BIND) > 0) {
        this._setBoundTo(parent._boundTo);
    }
    if ((flags & PROPAGATE_TRACE) > 0) {
        this._setTrace(parent);
    }
};

Promise.prototype._fulfill = function (value) {
    if (this._isFollowingOrFulfilledOrRejected()) return;
    this._fulfillUnchecked(value);
};

Promise.prototype._reject = function (reason, carriedStackTrace) {
    if (this._isFollowingOrFulfilledOrRejected()) return;
    this._rejectUnchecked(reason, carriedStackTrace);
};

Promise.prototype._settlePromiseAt = function (index) {
    var handler = this.isFulfilled()
        ? this._fulfillmentHandlerAt(index)
        : this._rejectionHandlerAt(index);

    ASSERT(this.isFulfilled() || this.isRejected());

    var carriedStackTrace =
        this._isCarryingStackTrace() ? this._getCarriedStackTrace() : undefined;
    var value = this._settledValue;
    var receiver = this._receiverAt(index);
    var promise = this._promiseAt(index);
    this._clearCallbackDataAtIndex(index);

    if (typeof handler === "function") {
        //if promise is not instanceof Promise
        //it is internally smuggled data
        if (!(promise instanceof Promise)) {
            handler.call(receiver, value, promise);
        } else {
            this._settlePromiseFromHandler(handler, receiver, value, promise);
        }
    } else {
        var done = false;
        var isFulfilled = this.isFulfilled();
        //optimization when .then listeners on a promise are
        //just respective fate sealers on some other promise
        if (receiver !== undefined) {
            if (receiver instanceof Promise &&
                receiver._isProxied()) {
                if (receiver.isRejected()) return;
                ASSERT(!receiver.isFulfilled() && !receiver.isRejected());
                //Must be smuggled data if proxied
                receiver._unsetProxied();

                if (isFulfilled) receiver._fulfillUnchecked(value);
                else receiver._rejectUnchecked(value,
                    this._getCarriedStackTrace());
                done = true;
            } else if (receiver instanceof PromiseArray) {
                if (!receiver._isResolved()) {
                    if (isFulfilled) {
                        receiver._promiseFulfilled(value, promise);
                    }
                    else {
                        receiver._promiseRejected(value, promise);
                    }
                }
                done = true;
            }
        }

        if (!done) {
            if (isFulfilled) promise._fulfill(value);
            else promise._reject(value, carriedStackTrace);
        }
    }
};

Promise.prototype._clearCallbackDataAtIndex = function(index) {
    if (index === 0) {
        if (!this._isCarryingStackTrace()) {
            this._fulfillmentHandler0 = undefined;
        }
        this._rejectionHandler0 =
        this._progressHandler0 =
        this._receiver0 =
        this._promise0 = undefined;
    } else {
        var base = index * CALLBACK_SIZE - CALLBACK_SIZE;
        this[base + CALLBACK_PROMISE_OFFSET] =
        this[base + CALLBACK_RECEIVER_OFFSET] =
        this[base + CALLBACK_FULFILL_OFFSET] =
        this[base + CALLBACK_REJECT_OFFSET] =
        this[base + CALLBACK_PROGRESS_OFFSET] = undefined;
    }
};

Promise.prototype._isProxied = function () {
    return (this._bitField & IS_PROXIED) === IS_PROXIED;
};

Promise.prototype._setProxied = function () {
    this._bitField = this._bitField | IS_PROXIED;
};

Promise.prototype._unsetProxied = function () {
    this._bitField = this._bitField & (~IS_PROXIED);
};

Promise.prototype._isSettlePromisesQueued = function () {
    return (this._bitField &
            IS_SETTLE_PROMISES_QUEUED) === IS_SETTLE_PROMISES_QUEUED;
};

Promise.prototype._setSettlePromisesQueued = function () {
    this._bitField = this._bitField | IS_SETTLE_PROMISES_QUEUED;
};

Promise.prototype._unsetSettlePromisesQueued = function () {
    this._bitField = this._bitField & (~IS_SETTLE_PROMISES_QUEUED);
};

Promise.prototype._queueSettlePromises = function() {
    if (!this._isSettlePromisesQueued()) {
        async.invoke(this._settlePromises, this, undefined);
        this._setSettlePromisesQueued();
    }
};

Promise.prototype._fulfillUnchecked = function (value) {
    ASSERT(!this.isFulfilled() && !this.isRejected());
    if (value === this) {
        var err = makeSelfResolutionError();
        this._attachExtraTrace(err);
        return this._rejectUnchecked(err, undefined);
    }
    this._setFulfilled();
    this._settledValue = value;
    this._cleanValues();

    if (this._length() > 0) {
        this._queueSettlePromises();
    }
};

Promise.prototype._rejectUncheckedCheckError = function (reason) {
    var trace = canAttachTrace(reason) ? reason : new Error(reason + "");
    this._rejectUnchecked(reason, trace === reason ? undefined : trace);
};

Promise.prototype._rejectUnchecked = function (reason, trace) {
    ASSERT(!this.isFulfilled() && !this.isRejected());
    if (reason === this) {
        var err = makeSelfResolutionError();
        this._attachExtraTrace(err);
        return this._rejectUnchecked(err);
    }
    this._setRejected();
    this._settledValue = reason;
    this._cleanValues();

    if (this._isFinal()) {
        ASSERT(this._length() === 0);
        async.invokeLater(function(e) {
            if ("stack" in e) {
                async.invokeFirst(
                    CapturedTrace.unhandledRejection, undefined, e);
            }
            throw e;
        }, undefined, trace === undefined ? reason : trace);
        return;
    }

    if (trace !== undefined) this._setCarriedStackTrace(trace);

    if (this._length() > 0) {
        this._queueSettlePromises();
    } else {
        this._ensurePossibleRejectionHandled();
    }
};

Promise.prototype._settlePromises = function () {
    this._unsetSettlePromisesQueued();
    var len = this._length();
    this._setLength(0);
    for (var i = 0; i < len; i++) {
        this._settlePromiseAt(i);
    }
};

Promise.prototype._ensurePossibleRejectionHandled = function () {
    this._setRejectionIsUnhandled();
    if (CapturedTrace.possiblyUnhandledRejection !== undefined) {
        async.invokeLater(this._notifyUnhandledRejection, this, undefined);
    }
};

Promise.prototype._notifyUnhandledRejectionIsHandled = function () {
    if (typeof unhandledRejectionHandled === "function") {
        async.invokeLater(unhandledRejectionHandled, undefined, this);
    }
};

Promise.prototype._notifyUnhandledRejection = function () {
    if (this._isRejectionUnhandled()) {
        var reason = this._settledValue;
        var trace = this._getCarriedStackTrace();

        this._setUnhandledRejectionIsNotified();

        if (trace !== undefined) {
            this._unsetCarriedStackTrace();
            reason = trace;
        }
        if (typeof CapturedTrace.possiblyUnhandledRejection === "function") {
            CapturedTrace.possiblyUnhandledRejection(reason, this);
        }
    }
};

var contextStack = [];
Promise.prototype._peekContext = function () {
    var lastIndex = contextStack.length - 1;
    if (lastIndex >= 0) {
        return contextStack[lastIndex];
    }
    return undefined;

};

Promise.prototype._pushContext = function () {
    if (!debugging) return;
    contextStack.push(this._trace);
};

Promise.prototype._popContext = function () {
    if (!debugging) return;
    contextStack.pop();
};

Promise.prototype._resolveFromSyncValue = function (value) {
    if (value === errorObj) {
        this._setRejected();
        var reason = value.e;
        this._settledValue = reason;
        this._cleanValues();
        this._attachExtraTrace(reason);
        this._ensurePossibleRejectionHandled();
    } else {
        var maybePromise = tryConvertToPromise(value, this);
        if (maybePromise instanceof Promise) {
            this._follow(maybePromise);
        } else {
            this._setFulfilled();
            this._settledValue = value;
            this._cleanValues();
        }
    }
};

if (!CapturedTrace.isSupported()) {
    Promise.longStackTraces = function(){};
    debugging = false;
}

Promise._makeSelfResolutionError = makeSelfResolutionError;
require("./finally.js")(Promise, NEXT_FILTER, tryConvertToPromise);
require("./direct_resolve.js")(Promise);
require("./synchronous_inspection.js")(Promise);
require("./join.js")(Promise, PromiseArray, tryConvertToPromise, INTERNAL);
Promise.RangeError = RangeError;
Promise.CancellationError = CancellationError;
Promise.TimeoutError = TimeoutError;
Promise.TypeError = TypeError;
Promise.OperationalError = OperationalError;
Promise.RejectionError = OperationalError;
Promise.AggregateError = errors.AggregateError;

util.toFastProperties(Promise);
util.toFastProperties(Promise.prototype);
Promise.Promise = Promise;
CapturedTrace.setBounds(async.firstLineError, util.lastLineError);
};
