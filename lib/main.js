//
// firefox-framerate-monitor/lib/main.js
//
// Copyright (c) 2010 Mozilla Foundation
// Patrick Walton <pcwalton@mozilla.com>
//

let { Cc, Ci, Cu } = require('chrome');
let data = require('self').data;
let Shark = require('shark').Shark;

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const MAX_SAMPLES = 2000;

let imports = {};

// The monitoring logic

function Monitor(delegate) {
    this._delegate = delegate;
    this._potentialPaintCount = 0;

    this._onBeforePaint = this._onBeforePaint.bind(this);
}

Monitor.prototype = {
    _onBeforePaint: function() {
        this._potentialPaintCount++;
        this._window.mozRequestAnimationFrame();
    },

    observe: function(subject, topic, data) {
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

        let window = this._delegate.window;
        let requestor = window.QueryInterface(Ci.nsIInterfaceRequestor);
        let windowUtils = requestor.getInterface(Ci.nsIDOMWindowUtils);
        this._window = windowUtils.getOuterWindowWithId(windowID);

        this._model = model;

        this._window.addEventListener("MozBeforePaint", this._onBeforePaint,
                                      false);

        this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        this._timer.init(this, 333, Ci.nsITimer.TYPE_REPEATING_PRECISE);

        this._prevPaintCount = this._window.mozPaintCount;

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

            let sampleIndex = samples.length - (canvasWidth - 16);
            sampleIndex = Math.floor(sampleIndex);

            let opacity = 0;
            for (let x = 16; x < canvasWidth; x++) {
                if (sampleIndex >= 0 && sampleIndex < samples.length) {
                    let sample = samples[sampleIndex];

                    // Smooth out the graph a little bit
                    let potential, actual;
                    if (sampleIndex > 2) {
                        let lastSample0 = samples[sampleIndex - 2];
                        let lastSample1 = samples[sampleIndex - 1];

                        potential = (sample.potential + lastSample0.potential +
                                    lastSample1.potential) / 3;
                        actual = (sample.actual + lastSample0.actual +
                                 lastSample1.actual) / 3;
                    } else {
                        potential = sample.potential;
                        actual = sample.actual;
                    }

                    ctx.globalAlpha = opacity;
                    ctx.fillStyle = gradient;
                    let potentialHeight = Math.min(canvasHeight / 60 *
                                                   potential,
                                                   canvasHeight);
                    let y = canvasHeight - potentialHeight;
                    ctx.fillRect(x, y, 1, potentialHeight);

                    ctx.globalAlpha = 0.5;
                    ctx.fillStyle = "#000000";
                    let shadeHeight = Math.max(0,
                        Math.min(canvasHeight / 60 * (potential - actual),
                                 canvasHeight));
                    ctx.fillRect(x, y, 1, shadeHeight);
                }

                sampleIndex++;

                if (opacity < 1)
                    opacity = Math.min(opacity + 0.03, 1.0);
            }
        }

        // Horizontal lines
        ctx.fillStyle = "#ffffff";
        for (let i = 0; i < 6; i++) {
            let y = Math.floor(i * canvasHeight / 6);
            ctx.globalAlpha = 0.25;
            ctx.fillRect(0, y, canvasWidth, 1);
            ctx.globalAlpha = 0.5;
            ctx.font = "10px Lucida Grande, Segoe UI, Tahoma, sans-serif";
            ctx.fillText(10 * (6 - i), 3, y + 12);
        }

        ctx.globalAlpha = 1.0;
    }
};

// The main window

let framerateWindowInstance = null;

function FramerateWindow() {
    let wm = imports.Services.wm.getMostRecentWindow('navigator:browser');
    this._browserWindow = wm.openDialog("chrome://browser/content/browser.xul",
                                        'frameRateMonitor',
                                        "chrome,close,resizable,menubar," +
                                        "titlebar,width=480,height=200",
                                        data.url("main-window.html"));

    this._browserWindow.addEventListener('DOMContentLoaded',
                                         this._onLoad.bind(this),
                                         null);
    this._browserWindow.addEventListener('close',
                                         this._onClose.bind(this),
                                         null);

    this.models = {};
    this.playing = true;

    this._monitor = new Monitor(this);

    try {
        this._shark = new Shark();
        this._autoStopProfiler = false;
    } catch (e) {
        dump("Failed to initialize Shark: " + e + "\n");
        this._shark = null;
    }

    imports.Services.ww.registerNotification(this);

    this._promptService = Cc["@mozilla.org/embedcomp/prompt-service;1"].
                          getService(Ci.nsIPromptService);

    this._profilingGroupShown = false;
}

FramerateWindow.prototype = {
    get chromeDocument() { return this.window.document; },

    focus: function() {
        this.window.focus();
    },

    modelUpdated: function() {
        this.view.redraw();

        let model = this.models[this._windowID];

        let samples = model.samples;
        let lastSample = samples[samples.length - 1];

        this.potentialFPSDisplay.innerHTML =
            "Potential: " + Math.floor(lastSample.potential) + " fps";
        this.actualFPSDisplay.innerHTML =
            "Actual: " + Math.floor(lastSample.actual) + " fps";

        if (this._autoStopProfiler) {
            let profilingThreshold = parseInt(this.profilingThreshold.value);
            if (lastSample.potential < profilingThreshold)
                this._stopProfiler();
        }

        this.leastFPSDisplay.innerHTML = "Min: " + model.least + " fps";
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

    _onClearButtonClick: function() {
        this._initModel(this._windowID);
        this.view.redraw();
    },

    _onClose: function() {
        this._monitor.stopMonitoring();
        imports.Services.ww.unregisterNotification(this);
        framerateWindowInstance = null;
    },

    _onPauseButtonClick: function() {
        if (this.playing) {
            this._monitor.stopMonitoring();
            this.pauseButtonImage.setAttribute("src", "play.gif");
        } else {
            let windowID = this._windowID;
            this._monitor.startMonitoring(windowID, this.models[windowID]);
            this.pauseButtonImage.setAttribute("src", "pause.gif");
        }
        this.playing = !this.playing;
    },

    _onResize: function() {
        this._resizeCanvasToFit();
        this.view.redraw();
    },

    _onLoad: function() {
        this.window = this._browserWindow.gBrowser.contentWindow;
        this.chromeDocument.addEventListener('load', this._onLoad.bind(this),
                                             false);

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

        this.clearButton.addEventListener("click",
            this._onClearButtonClick.bind(this), false);
        this.pauseButton.addEventListener("click",
            this._onPauseButtonClick.bind(this), false);

        this.profilingHeader.addEventListener("click",
            this._onProfilingHeaderClick.bind(this), false);

        this.autoStopProfilerButton.addEventListener("change",
            this._onAutoStopProfilerChange.bind(this), false);
        this.startSharkButton.addEventListener("click",
            this._onStartSharkButtonClick.bind(this), false);

        if (!this._shark) {
            this.startSharkButton.setAttribute("disabled", "disabled");
            this.profilingGroup.classList.add("disabled");
        }

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

    _initModel: function(windowID) {
        let model = this.models[windowID];
        model.least = 60;
        model.samples = [];
    },

    _onAutoStopProfilerChange: function() {
        if (this.autoStopProfilerButton.checked) {
            this.profilingThreshold.setAttribute("disabled", "disabled");
            this._autoStopProfiler = true;
        } else {
            this._turnOffAutoStopProfiler();
        }
    },

    _onProfilingHeaderClick: function() {
        if (!this._profilingGroupShown) {
            this.profilingGroup.classList.remove('hidden');
            this.profilingDisclosureImage.setAttribute("src",
                "arrow_expand.gif");
            this._profilingGroupShown = true;
        } else {
            this.profilingGroup.classList.add('hidden');
            this.profilingDisclosureImage.setAttribute("src",
                "arrow_collapse.gif");
            this._profilingGroupShown = false;
        }

        this._resizeCanvasToFit();
    },

    _onStartSharkButtonClick: function() {
        if (!this._profiling) {
            this._startProfiler();
        } else {
            this._stopProfiler();
        }
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
        if (!('windowID' in this.models)) {
            this.models[windowID] = {};
            this._initModel(windowID);
        }

        this._windowID = windowID;
        this.view.model = this.models[windowID];

        if (this.playing)
            this._monitor.startMonitoring(windowID, this.models[windowID]);
    },

    _startProfiler: function() {
        if (this._profiling)
            return;

        try {
            this._shark.start();
            this._profiling = true;
            this.startSharkButton.innerHTML = "Stop Profiling";

            this.autoStopProfilerGroup.classList.remove("disabled");
            this.autoStopProfilerButton.removeAttribute("disabled");
            this.profilingThreshold.removeAttribute("disabled");
        } catch (ex) {
            this._promptService.alert(null, "Frame Rate Monitor Error",
                                      "Failed to start Shark: " + ex);
            dump(ex.stack + "\n");
        }
    },

    _stopProfiler: function() {
        if (!this._profiling)
            return;

        try {
            this._shark.stop();
            this._profiling = false;
            this.startSharkButton.innerHTML = "Start Profiling";

            this._turnOffAutoStopProfiler();
            this.autoStopProfilerButton.checked = false;
            this.autoStopProfilerButton.setAttribute("disabled", "disabled");
            this.profilingThreshold.setAttribute("disabled", "disabled");
            this.autoStopProfilerGroup.classList.add("disabled");
        } catch (ex) {
            this._promptService.alert(null, "Frame Rate Monitor Error",
                                      "Failed to stop Shark: " + ex);
            dump(ex.stack + "\n");
        }
    },

    _turnOffAutoStopProfiler: function() {
        if (!this._autoStopProfiler)
            return;
        this.profilingThreshold.removeAttribute("disabled");
        this._autoStopProfiler = false;
    }
};

// Convenience accessors
[
    { name: 'canvas',                   id: "canvas"                        },
    { name: 'canvasContainer',          id: "canvas-container"              },
    { name: 'clearButton',              id: "clear-button"                  },
    { name: 'pauseButton',              id: "pause-button"                  },
    { name: 'pauseButtonImage',         id: "pause-button-image"            },
    { name: 'potentialFPSDisplay',      id: "potential-fps-display"         },
    { name: 'autoStopProfilerButton',   id: "auto-stop-profiler-button"     },
    { name: 'autoStopProfilerGroup',    id: "auto-stop-profiler-group"      },
    { name: 'startSharkButton',         id: "start-shark-button"            },
    { name: 'profilingDisclosureImage', id: "profiling-disclosure-image"    },
    { name: 'profilingHeader',          id: "profiling-header"              },
    { name: 'profilingGroup',           id: "profiling-group"               },
    { name: 'profilingThreshold',       id: "profiling-threshold"           },
    { name: 'actualFPSDisplay',         id: "actual-fps-display"            },
    { name: 'leastFPSDisplay',          id: "least-fps-display"             },
    { name: 'windowSelector',           id: "window-selector"               }
].forEach(function(obj) {
    Object.defineProperty(FramerateWindow.prototype, obj.name, {
        get: function() { return this.chromeDocument.getElementById(obj.id); }
    });
});

function openFramerateMonitor() {
    if (!framerateWindowInstance)
        framerateWindowInstance = new FramerateWindow();
    else
        framerateWindowInstance.focus();
}

// The menu item controller

function MenuItemController() {
    let enumerator = imports.Services.ww.getWindowEnumerator();
    while (enumerator.hasMoreElements()) {
        let domWindow = enumerator.getNext().QueryInterface(Ci.nsIDOMWindow);
        this._createMenuItem(domWindow.document);
    }

    this._onLoad = this._onLoad.bind(this);
    imports.Services.ww.registerNotification(this);
}

MenuItemController.prototype = {
    observe: function(subject, topic, data) {
        if (topic != 'domwindowopened')
            return;

        let domWindow = subject.QueryInterface(Ci.nsIDOMWindow);
        domWindow.addEventListener('load', this._onLoad, false);
    },

    _createMenuItem: function(chromeDocument) {
        let separator = chromeDocument.getElementById("sanitizeSeparator");
        if (!separator)
            return;

        let menuItem = chromeDocument.createElementNS(XUL_NS, "menuitem");
        menuItem.setAttribute("id", "frameRateMonitor");
        menuItem.setAttribute("label", "Frame Rate Monitor");
        menuItem.addEventListener("command", openFramerateMonitor, false);
        separator.parentNode.insertBefore(menuItem, separator);
    },

    _onLoad: function(ev) {
        let chromeDocument = ev.target;
        let domWindow = chromeDocument.defaultView;
        domWindow.removeEventListener('load', this._onLoad, false);
        this._createMenuItem(chromeDocument);
    }
}

// Entry point

exports.main = function() {
    Cu.import("resource://gre/modules/Services.jsm", imports);
    new MenuItemController();
}

