const { app, BrowserWindow } = require("electron");
app.setName("Nova Desktop Fixture");
app.commandLine.appendSwitch("force-renderer-accessibility");
app.setPath("userData", process.env.NOVA_DESKTOP_FIXTURE_DATA);
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 620, height: 360, show: true, webPreferences: { sandbox: true } });
  window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html><head><title>Nova Desktop Synthetic Fixture</title></head><body><h1>Desktop fixture</h1><input aria-label="Fixture note" id="fixture-note"><button id="test-button" onclick="this.textContent='Clicked';document.querySelector('#result').textContent='Clicked'">Test button</button><p id="result">Ready</p></body></html>`));
  setTimeout(() => app.quit(), 45000);
});
