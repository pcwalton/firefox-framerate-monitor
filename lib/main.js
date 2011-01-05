//
// Framerate monitor
//
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
}

Monitor.prototype = {
    _detach: function() {
        if (this._timer) {
            this._timer.cancel();
            this._timer = null;
        }
    },

    observe: function(subject, topic, data) {
        let thisPaintCount = this._window.mozPaintCount;
        let thisPaintTime = new Date().getTime();

        let paintCountDiff = thisPaintCount - this._prevPaintCount;
        let paintTimeDelta = thisPaintTime - this._prevPaintTime;
        let fps = paintCountDiff / paintTimeDelta * 1000;

        this._model.push(fps);
        if (this._model.length > MAX_SAMPLES)
            this._model.shift();

        this._delegate.modelUpdated();

        this._prevPaintCount = thisPaintCount;
        this._prevPaintTime = thisPaintTime;
    },

    startMonitoring: function(windowID, model) {
        this._detach();

        let window = this._delegate.window;
        let requestor = window.QueryInterface(Ci.nsIInterfaceRequestor);
        let windowUtils = requestor.getInterface(Ci.nsIDOMWindowUtils);
        this._window = windowUtils.getOuterWindowWithId(windowID);

        this._model = model;

        this._prevPaintCount = this._window.mozPaintCount;
        this._prevPaintTime = new Date().getTime();

        this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        this._timer.init(this, 1000, Ci.nsITimer.TYPE_REPEATING_PRECISE);
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

        // Horizontal lines
        for (let i = 0; i < 6; i++) {
            let y = Math.floor(i * canvasHeight / 6);
            ctx.fillStyle = "#404040";
            ctx.fillRect(0, y, canvasWidth, 1);
            ctx.fillStyle = "#808080";
            ctx.font = "10px Lucida Grande, Segoe UI, Tahoma";
            ctx.fillText(10 * (6 - i), 3, y + 12);
        }

        // Samples
        if (this.model) {
            let gradient = ctx.createLinearGradient(0, 0, 0, canvasHeight);
            gradient.addColorStop(0.0, "green");
            gradient.addColorStop(0.5, "yellow");
            gradient.addColorStop(1.0, "red");
            ctx.fillStyle = gradient;

            let sampleIndex = this.model.length - (canvasWidth - 16) / 2;
            sampleIndex = Math.floor(sampleIndex);

            for (let x = 16; x < canvasWidth; x += 2) {
                if (sampleIndex >= 0 && sampleIndex < this.model.length) {
                    let sample = this.model[sampleIndex];
                    let h = Math.min(canvasHeight / 60 * sample, canvasHeight);
                    ctx.fillRect(x, canvasHeight - h, 2, h);
                }

                sampleIndex++;
            }
        }
    }
};

// The main window

let framerateWindowInstance = null;

function FramerateWindow() {
    let ww = imports.Services.ww;
    this.window = ww.openWindow(null,
                                data.url("main-window.html"),
                                'frameRateMonitor',
                                "resizable,centerscreen",
                                null);

    this.window.addEventListener('close', this._onClose.bind(this), null);
    this.window.addEventListener('load', this._onLoad.bind(this), null);

    this.models = {};

    this._monitor = new Monitor(this);
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
    get windowSelector() {
        return this.chromeDocument.getElementById('window-selector');
    },

    close: function() { this.window.close(); },

    modelUpdated: function() {
        this.view.redraw();

        let model = this.models[this._windowID];
        let lastFPS = model[model.length - 1];
        this.fpsDisplay.innerHTML = Math.floor(lastFPS) + " frames/s";
    },

    _onClose: function() { this.framerateWindowInstance = null; },

    _onResize: function() {
        let canvas = this.canvas, canvasContainer = this.canvasContainer;
        canvas.width = canvas.height = 1;
        canvas.width = canvasContainer.clientWidth;
        canvas.height = canvasContainer.clientHeight;
        this.view.redraw();
    },

    _onLoad: function() {
        this.view = new FramerateView(this.canvas);

        let enumerator = imports.Services.ww.getWindowEnumerator();
        while (enumerator.hasMoreElements()) {
            let unknown = enumerator.getNext();
            let domWindow = unknown.QueryInterface(Ci.nsIDOMWindow);
            this._addWindowToWindowList(domWindow);
        }

        this.window.setTimeout(this._drawInitially.bind(this), 0);
    },

    _addWindowToWindowList: function(domWindow) {
        let option = this.chromeDocument.createElement("option");

        let requestor = domWindow.QueryInterface(Ci.nsIInterfaceRequestor);
        let windowUtils = requestor.getInterface(Ci.nsIDOMWindowUtils);
        let windowID = windowUtils.outerWindowID;

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

    _startMonitoringWindowWithID: function(windowID) {
        if (!('windowID' in this.models))
            this.models[windowID] = [];

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

    imports.Services.ww.registerNotification(observer);
}

