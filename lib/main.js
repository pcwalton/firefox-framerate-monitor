//
// Framerate monitor
//
// Patrick Walton <pcwalton@mozilla.com>
//

let { Cc, Ci, Cu } = require('chrome');

const HTML_NS = "http://www.w3.org/1999/xhtml";
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const VIEW_HEIGHT = 200;
const MAX_SAMPLES = 2000;

let globals = {};

let observer = {
    observe: function(aSubject, aTopic, aData) {
        // TODO: attach to windows
    }
};

function FramerateView(domWindow) {
    this.domWindow = domWindow;
    this.chromeDocument = domWindow.document;
    this.bottomBox = this.chromeDocument.getElementById("browser-bottombox");

    this.ourBox = this.chromeDocument.createElementNS(XUL_NS, "vbox");
    this.ourBox.setAttribute("style", "height: " + VIEW_HEIGHT + "px;");
    this.bottomBox.appendChild(this.ourBox);

    this.canvas = this.chromeDocument.createElementNS(HTML_NS, "canvas");
    this._resizeCanvasToFit();
    this.ourBox.appendChild(this.canvas);

    this._prevPaintCount = this.domWindow.mozPaintCount;
    this._prevPaintTime = new Date().getTime();
    this._samples = [];

    this._createRedrawTimer();
    this._redraw();

    let self = this;
    this.domWindow.addEventListener("resize", function() {
        self._resizeCanvasToFit();
    }, false);

    this.domWindow.framerateView = this;
}

FramerateView.prototype = {
    _resizeCanvasToFit: function() {
        this.canvas.width = this.domWindow.innerWidth;
        this.canvas.height = VIEW_HEIGHT;
    },

    _createRedrawTimer: function() {
        this.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        this.timer.init(this, 1000, Ci.nsITimer.TYPE_REPEATING_PRECISE);
    },

    // Called when the timer goes off.
    observe: function(aSubject, aTopic, aData) {
        let thisPaintCount = this.domWindow.mozPaintCount;
        let thisPaintTime = new Date().getTime();

        let paintCountDiff = thisPaintCount - this._prevPaintCount;
        let paintTimeDelta = thisPaintTime - this._prevPaintTime;
        let fps = paintCountDiff / paintTimeDelta * 1000;

        this._samples.push(fps);
        if (this._samples.length > MAX_SAMPLES)
            this._samples.shift();

        this._redraw();

        this._prevPaintCount = thisPaintCount;
        this._prevPaintTime = thisPaintTime;
    },

    _redraw: function() {
        let ctx = this.canvas.getContext('2d');
        let w = this.canvas.width, h = this.canvas.height;

        // Background
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, w, h);

        // Background grid
        ctx.fillStyle = "#888";
        let step = h / 6;
        for (let i = step; i < h; i += step)
            ctx.fillRect(0, Math.floor(i), w, 1);
        for (let i = 0; i < w; i += 100)
            ctx.fillRect(i, 0, 1, h);

        // Graph data
        let gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0.0, "green");
        gradient.addColorStop(0.5, "yellow");
        gradient.addColorStop(1.0, "red");
        ctx.fillStyle = gradient;

        let firstSampleIndex = Math.max(0, this._samples.length - w);
        let sampleIndex = 0;
        for (let i = 0; i < w; i += 2) {
            if (sampleIndex >= this._samples.length)
                break;
            let sample = this._samples[sampleIndex];

            let dataHeight = Math.min(h / 60 * sample, h);
            ctx.fillRect(i, h - dataHeight, 2, h);

            sampleIndex++;
        }

        // FPS text display
        if (!this._samples.length)
            return;

        let lastSample = this._samples[this._samples.length - 1];
        ctx.fillStyle = "white";
        ctx.fillText(Math.floor(lastSample) + " frames/s", 3, 12);
    }
}

exports.main = function() {
    Cu.import("resource://gre/modules/Services.jsm", globals);
    let enumerator = globals.Services.ww.getWindowEnumerator();
    while (enumerator.hasMoreElements()) {
        let domWindow = enumerator.getNext().QueryInterface(Ci.nsIDOMWindow);
        new FramerateView(domWindow);
    }

    globals.Services.ww.registerNotification(observer);
}

