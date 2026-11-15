const { app, BrowserWindow } = require("electron");
app.setName("Nova Desktop Fixture");
app.commandLine.appendSwitch("force-renderer-accessibility");
app.setPath("userData", process.env.NOVA_DESKTOP_FIXTURE_DATA);
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 620, height: 360, show: true, webPreferences: { sandbox: true } });
  window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html><head><title>Nova Desktop Synthetic Fixture</title></head><body><h1>Desktop fixture</h1><input aria-label="Fixture note" id="fixture-note"><button id="test-button" onclick="this.textContent='Clicked';document.querySelector('#result').textContent='Clicked'">Test button</button><p id="result">Ready</p><canvas id="fixture-noise" width="256" height="256"></canvas><script>const c=document.querySelector('#fixture-noise'),x=c.getContext('2d'),i=x.createImageData(256,256);let n=123456789;for(let k=0;k<i.data.length;k+=4){n^=n<<13;n^=n>>>17;n^=n<<5;i.data[k]=n&255;i.data[k+1]=(n>>>8)&255;i.data[k+2]=(n>>>16)&255;i.data[k+3]=255}x.putImageData(i,0,0)</script></body></html>`));
  setTimeout(() => app.quit(), 45000);
});
