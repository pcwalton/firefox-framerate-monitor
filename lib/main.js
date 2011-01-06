//
// Framerate monitor
//
// Copyright (c) 2010 Mozilla Foundation
// Patrick Walton <pcwalton@mozilla.com>
//

let { Cc, Ci, Cu } = require('chrome');
let data = require('self').data;

const HTML_NS = "http://www.w3.org/1999/xhtml";
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const VIEW_HEIGHT = 200;
const MAX_SAMPLES = 2000;

let imports = {};

// The monitoring logic

function Monitor(delegate) {
    this._delegate = delegate;
    this._paintCount = 0;

    this._onBeforePaint = this._onBeforePaint.bind(this);
}

Monitor.prototype = {
    _onBeforePaint: function() {
        this._paintCount++;
        this._window.mozRequestAnimationFrame();
    },

    observe: function(subject, topic, data) {
        let fps = this._paintCount;

        this._model.samples.push(fps);
        if (this._model.samples.length > MAX_SAMPLES)
            this._model.samples.shift();

        if (fps < this._model.least)
            this._model.least = fps;

        this._delegate.modelUpdated();

        this._paintCount = 0;
    },

    startMonitoring: function(windowID, model) {
        this.stopMonitoring();

        let window = this._delegate.window;
        let requestor = window.QueryInterface(Ci.nsIInterfaceRequestor);
        let windowUtils = requestor.getInterface(Ci.nsIDOMWindowUtils);
        this._window = windowUtils.getOuterWindowWithId(windowID);

        this._model = model;

        this._prevPaintCount = this._window.mozPaintCount;
        this._prevPaintTime = new Date().getTime();

        this._window.addEventListener("MozBeforePaint", this._onBeforePaint,
                                      false);

        this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        this._timer.init(this, 1000, Ci.nsITimer.TYPE_REPEATING_PRECISE);

        this._window.mozRequestAnimationFrame();
    },

    stopMonitoring: function() {
        if (this._timer) {
            this._timer.cancel();
            this._timer = null;
        }
        if (this._window) {
            this._window.removeEventListener("MozBeforePaint",
                                             this._onBeforePaint, false);
            this._window = null;
        }
    }
};

// The graph display

function FramerateView(canvas) {
    this.canvas = canvas;
    this.model = null;
}

FramerateView.prototype = {
    redraw: function() {
        let ctx = this.canvas.getContext('2d');
        let canvasWidth = this.canvas.width, canvasHeight = this.canvas.height;

        // Background
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // Vertical lines
        ctx.fillStyle = "#404040";
        for (let i = 0; i < canvasWidth; i += 50)
            ctx.fillRect(i, 0, 1, canvasHeight);

        // Samples
        if (this.model && this.model.samples) {
            let samples = this.model.samples;

            let gradient = ctx.createLinearGradient(0, 0, 0, canvasHeight);
            gradient.addColorStop(0.0, "green");
            gradient.addColorStop(0.5, "yellow");
            gradient.addColorStop(1.0, "red");
            ctx.fillStyle = gradient;

            let sampleIndex = samples.length - (canvasWidth - 16) / 2;
            sampleIndex = Math.floor(sampleIndex);

            let opacity = 0;
            for (let x = 16; x < canvasWidth; x += 2) {
                if (sampleIndex >= 0 && sampleIndex < samples.length) {
                    ctx.globalAlpha = opacity;
                    let sample = samples[sampleIndex];
                    let h = Math.min(canvasHeight / 60 * sample, canvasHeight);
                    ctx.fillRect(x, canvasHeight - h, 2, h);
                }

                sampleIndex++;

                if (opacity < 1)
                    opacity += 0.1;
            }
        }

        // Horizontal lines
        ctx.fillStyle = "#ffffff";
        for (let i = 0; i < 6; i++) {
            let y = Math.floor(i * canvasHeight / 6);
            ctx.globalAlpha = 0.25;
            ctx.fillRect(0, y, canvasWidth, 1);
            ctx.globalAlpha = 0.5;
            ctx.font = "10px Lucida Grande, Segoe UI, Tahoma";
            ctx.fillText(10 * (6 - i), 3, y + 12);
        }

        ctx.globalAlpha = 1.0;
    }
};

// The main window

let framerateWindowInstance = null;

function FramerateWindow() {
    let ww = imports.Services.ww;
    this.window = ww.openWindow(null,
                                data.url("main-window.html"),
                                'frameRateMonitor',
                                "resizable,centerscreen,width=480,height=200",
                                null);

    this.window.addEventListener('close', this._onClose.bind(this), null);
    this.window.addEventListener('load', this._onLoad.bind(this), null);

    this.models = {};

    this._monitor = new Monitor(this);

    imports.Services.ww.registerNotification(this);
}

FramerateWindow.prototype = {
    get chromeDocument() { return this.window.document; },
    get canvas() {
        return this.chromeDocument.getElementById('canvas');
    },
    get canvasContainer() {
        return this.chromeDocument.getElementById('canvas-container');
    },
    get fpsDisplay() {
        return this.chromeDocument.getElementById('fps-display');
    },
    get leastFPSDisplay() {
        return this.chromeDocument.getElementById('least-fps-display');
    },
    get windowSelector() {
        return this.chromeDocument.getElementById('window-selector');
    },

    modelUpdated: function() {
        this.view.redraw();

        let model = this.models[this._windowID];

        let samples = model.samples;
        let lastFPS = samples[samples.length - 1];
        this.fpsDisplay.innerHTML = Math.floor(lastFPS) + " fps";

        this.leastFPSDisplay.innerHTML = "Slowest: " + model.least + " fps";
    },

    observe: function(subject, topic, data) {
        switch (topic) {
        case "domwindowopened":
            this._addWindowToWindowList(subject);
            break;
        case "domwindowclosed":
            this._removeWindowFromWindowList(subject);
            break;
        }
    },

    _onChange: function() {
        let index = this.windowSelector.selectedIndex;
        let windowID = this.windowSelector.options[index].windowID;
        this._startMonitoringWindowWithID(windowID);
        this.view.redraw();
    },

    _onClose: function() {
        this.framerateWindowInstance = null;
        this._monitor.stopMonitoring();
        imports.Services.ww.unregisterNotification(this);
    },

    _onResize: function() {
        this._resizeCanvasToFit();
        this.view.redraw();
    },

    _onLoad: function() {
        this._resizeCanvasToFit();

        this.view = new FramerateView(this.canvas);

        let enumerator = imports.Services.ww.getWindowEnumerator();
        while (enumerator.hasMoreElements()) {
            let unknown = enumerator.getNext();
            let domWindow = unknown.QueryInterface(Ci.nsIDOMWindow);
            this._addWindowToWindowList(domWindow);
        }

        this.windowSelector.addEventListener("change",
                                             this._onChange.bind(this), false);

        this.window.setTimeout(this._drawInitially.bind(this), 0);
    },

    _addWindowToWindowList: function(domWindow) {
        let option = this.chromeDocument.createElement("option");

        let windowID = this._getWindowIDForWindow(domWindow);

        option.innerHTML = domWindow.document.title + " (#" + windowID + ")";
        option.windowID = windowID;

        if (!this.windowSelector.firstChild)
            this._startMonitoringWindowWithID(windowID);

        this.windowSelector.appendChild(option);
    },

    _drawInitially: function() {
        this.view.redraw();
        this.window.addEventListener('resize', this._onResize.bind(this),
                                     false);
    },

    _getWindowIDForWindow: function(domWindow) {
        let requestor = domWindow.QueryInterface(Ci.nsIInterfaceRequestor);
        let windowUtils = requestor.getInterface(Ci.nsIDOMWindowUtils);
        return windowUtils.outerWindowID;
    },

    _removeWindowFromWindowList: function(domWindow) {
        let windowID = this._getWindowIDForWindow(domWindow);

        let option = this.windowSelector.firstChild;
        while (option) {
            let nextOption = option.nextSibling;
            if (option.windowID == windowID)
                this.windowSelector.removeChild(option);
            option = nextOption;
        }

        if (this._windowID == windowID) {
            this.windowSelector.selectedIndex = 0;
            this._onChange();
        }
    },

    _resizeCanvasToFit: function() {
        let canvas = this.canvas, canvasContainer = this.canvasContainer;
        canvas.width = canvas.height = 1;
        canvas.width = canvasContainer.clientWidth;
        canvas.height = canvasContainer.clientHeight;
    },

    _startMonitoringWindowWithID: function(windowID) {
        if (!('windowID' in this.models))
            this.models[windowID] = { samples: [], least: 60 };

        this._windowID = windowID;
        this._monitor.startMonitoring(windowID, this.models[windowID]);
        this.view.model = this.models[windowID];
    }
};

function openFramerateMonitor() {
    if (!framerateWindowInstance)
        framerateWindowInstance = new FramerateWindow();
    else
        framerateWindowInstance.focus();
}

// Entry point

function createFramerateMenuItem(domWindow) {
    let chromeDocument = domWindow.document;
    let separator = chromeDocument.getElementById("sanitizeSeparator");

    let menuItem = chromeDocument.createElementNS(XUL_NS, "menuitem");
    menuItem.setAttribute("label", "Frame Rate Monitor");
    menuItem.addEventListener("command", openFramerateMonitor, false);
    separator.parentNode.insertBefore(menuItem, separator);
}

exports.main = function() {
    Cu.import("resource://gre/modules/Services.jsm", imports);
    let enumerator = imports.Services.ww.getWindowEnumerator();
    while (enumerator.hasMoreElements()) {
        let domWindow = enumerator.getNext().QueryInterface(Ci.nsIDOMWindow);
        createFramerateMenuItem(domWindow);
    }
}

