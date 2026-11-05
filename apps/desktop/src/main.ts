import { app, BrowserWindow } from 'electron';

void app.whenReady().then(() => {
  new BrowserWindow({ width: 1280, height: 800 });
});
