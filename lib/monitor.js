//
// firefox-framerate-monitor/lib/monitor.js
//
// Copyright (c) 2010 Mozilla Foundation
// Patrick Walton <pcwalton@mozilla.com>
//

let { Cc, Ci, Cu } = require('chrome');

const MAX_SAMPLES = 2000;

// The monitoring logic

function Monitor(delegate, window) {
    this.model = {};
    this.resetModel();

    this._delegate = delegate;
    this._potentialPaintCount = 0;
    this._monitoring = false;
    this._window = window;

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

        let samples = this.model.samples;
        samples.push({ potential: potential, actual: actual });
        if (samples.length > MAX_SAMPLES)
            samples.shift();

        if (potential < this.model.least)
            this.model.least = potential;

        this._delegate.modelUpdated(this.model);

        this._potentialPaintCount = 0;
        this._prevPaintCount = paintCount;
    },

    resetModel: function() {
        this.model.least = 60;
        this.model.samples = [];
    },

    startMonitoring: function() {
        this.stopMonitoring();

        this._monitoring = true;

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

        if (this._interval)
            this._window.clearInterval(this._interval);
    }
};

exports.Monitor = Monitor;

