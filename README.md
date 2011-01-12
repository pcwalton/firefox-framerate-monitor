This is a simple framerate monitor for Firefox 4. The first version was hacked
up in an hour or two. Expect many bugs!

To install, unpack this into the `packages/` directory in the Jetpack SDK. You
can get the Jetpack SDK here [1]. Enter the Jetpack SDK, and use
`source bin/activate`. Then enter `packages/firefox-framerate-monitor`, and use
`cfx run` to start Firefox.

If you'd like a pre-built binary, just download the XPI from the GitHub project
page [2]. Save the XPI file from the Downloads area (just click the big
Downloads button) to your disk, and drag the file into Firefox to use it.

At the moment, profiling requires Mac OS X and Shark. You'll need to start
Shark in remote mode to use the profiler. To switch to remote mode, choose
"Programmatic (Remote)" from the Tools menu or press Cmd+Shift+R inside Shark.
The most useful settings are WTF (windowed time facility) mode with 10000
samples, 20 usec sampling interval (not the default), and no time limit.

Enjoy!
-pcwalton

[1]: https://jetpack.mozillalabs.com/ 
[2]: https://github.com/pcwalton/firefox-framerate-monitor 

