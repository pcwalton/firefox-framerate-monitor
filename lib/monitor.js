//
// firefox-framerate-monitor/lib/monitor.js
//
// Copyright (c) 2010 Mozilla Foundation
// Patrick Walton <pcwalton@mozilla.com>
//

let { Cc, Ci, Cu } = require('chrome');

const MAX_SAMPLES = 2000;

// The monitoring logic

function Monitor(delegate) {
    this._delegate = delegate;
    this._potentialPaintCount = 0;
    this._monitoring = false;

    this._onBeforePaint = this._onBeforePaint.bind(this);
    this._timerFired = this._timerFired.bind(this);
}

Monitor.prototype = {
    _onBeforePaint: function() {
        this._potentialPaintCount++;
        if (this._monitoring)
            this._window.mozRequestAnimationFrame(this._onBeforePaint);
    },

    _timerFired: function() {
        let paintCount = this._window.mozPaintCount;
        let actual = paintCount - this._prevPaintCount;
        let potential = Math.max(this._potentialPaintCount, actual);

        potential *= 3;
        actual *= 3;

        let samples = this._model.samples;
        samples.push({ potential: potential, actual: actual });
        if (samples.length > MAX_SAMPLES)
            samples.shift();

        if (potential < this._model.least)
            this._model.least = potential;

        this._delegate.modelUpdated();

        this._potentialPaintCount = 0;
        this._prevPaintCount = paintCount;
    },

    startMonitoring: function(windowID, model) {
        this.stopMonitoring();

        this._monitoring = true;

        let window = this._delegate.window;
        let requestor = window.QueryInterface(Ci.nsIInterfaceRequestor);
        let windowUtils = requestor.getInterface(Ci.nsIDOMWindowUtils);
        this._window = windowUtils.getOuterWindowWithId(windowID);

        this._model = model;

        this._interval = this._window.setInterval(this._timerFired, 334);

        this._prevPaintCount = this._window.mozPaintCount;
        this._window.mozRequestAnimationFrame(this._onBeforePaint);
    },

    stopMonitoring: function() {
        this._monitoring = false;

        if (this._timer) {
            this._timer.cancel();
            this._timer = null;
        }
        if (this._window) {
            if (this._interval)
                this._window.clearInterval(this._interval);
            this._window = null;
        }
    }
};

exports.Monitor = Monitor;
