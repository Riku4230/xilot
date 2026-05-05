import { cpSync, renameSync, existsSync, rmSync, readFileSync, writeFileSync } from "fs";

const dist = "dist";

cpSync("src/manifest.json", `${dist}/manifest.json`);
cpSync("public/icons", `${dist}/icons`, { recursive: true });

if (existsSync(`${dist}/src/sidepanel/index.html`)) {
  let html = readFileSync(`${dist}/src/sidepanel/index.html`, "utf-8");
  html = html.replace(/src="\.\.\/\.\.\/sidepanel\.js"/g, 'src="./sidepanel.js"');
  html = html.replace(/href="\.\.\/\.\.\/assets\//g, 'href="./assets/');
  writeFileSync(`${dist}/sidepanel.html`, html);
  rmSync(`${dist}/src`, { recursive: true });
}

console.log("Postbuild complete");
