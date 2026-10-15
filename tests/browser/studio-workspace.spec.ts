import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ProjectPackageSchema } from "@handthesia/contracts";
import { exportStudioPackage, loadStudioSong, openStudioInspector, saveStudioProject, settledStudio, studioMidiPath } from "./studio-helpers";

const sizes = [
  {width:1920,height:1080}, {width:1440,height:900}, {width:1366,height:768},
  {width:1024,height:768}, {width:768,height:1024}, {width:390,height:844},
];

type Geometry = {
  notes: Array<{noteId:string;pitch:number;rect:{x:number;y:number;width:number;height:number}}>;
  keyboardRect:{x:number;y:number;width:number;height:number}|null;
  rendererSize:{width:number;height:number};keyCount:number;minPitch:number;maxPitch:number;viewTime:number;
};

async function geometry(page:Page):Promise<Geometry> {
  return page.evaluate(() => window.__playerSnapshot!.scene);
}

test("six responsive sizes preserve one scene, all keys, contextual tools and panel focus", async ({page}, info) => {
  // Capturing every mode at six sizes is slower with software-rendered MSAA.
  test.setTimeout(300_000);
  const errors:string[]=[];
  page.on("pageerror", error=>errors.push(error.message));
  let workers=0;
  page.on("worker",worker=>{if(worker.url().includes("midi-analysis.worker")) workers++;});
  await page.goto("/");
  for (const size of sizes) {
    await page.setViewportSize(size);
    await expect(page.getByRole("button",{name:"Open MIDI",exact:true})).toBeInViewport();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(`${size.width}x${size.height}-empty.png`)});
  }
  await page.setViewportSize(sizes[0]);
  await loadStudioSong(page);
  const canvas=page.locator("#piano-canvas-container canvas");
  await canvas.evaluate(el=>el.setAttribute("data-identity-probe","same-canvas"));
  const stableWorkerCount=workers;
  expect(stableWorkerCount).toBe(1); // Preparation hands its real Worker to the player.
  for (const size of sizes) {
    await page.setViewportSize(size);
    for (const mode of ["Performance","Fingering"] as const) {
      await page.getByRole("button",{name:mode,exact:true}).click();
      await expect(canvas).toBeVisible();
      await expect(canvas).toHaveAttribute("data-identity-probe","same-canvas");
      await expect(page.getByTestId("studio-workspace").locator("canvas")).toHaveCount(1);
      await expect.poll(async()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await expect(page.locator("#player-play-button")).toBeInViewport();
      await expect(page.getByTestId("studio-status")).toBeInViewport();
      await expect.poll(async()=>{
        const g=await geometry(page);
        const box=await canvas.boundingBox();
        return Boolean(box && Math.abs(g.rendererSize.width-box.width)<2 && Math.abs(g.rendererSize.height-box.height)<2);
      }).toBe(true);
      const g=await geometry(page);
      const backing=await canvas.evaluate((element:HTMLCanvasElement)=>{
        const gl=element.getContext("webgl2")??element.getContext("webgl");
        return {width:element.width,height:element.height,resolution:Math.min(2,Math.max(1,window.devicePixelRatio||1)),antialias:gl?.getContextAttributes()?.antialias??null};
      });
      // Verify actual framebuffer density and the existing WebGL context's AA,
      // rather than merely stretching a canvas or checking an option in source.
      expect(Math.abs(backing.width-g.rendererSize.width*backing.resolution)).toBeLessThanOrEqual(2);
      expect(Math.abs(backing.height-g.rendererSize.height*backing.resolution)).toBeLessThanOrEqual(2);
      if(backing.antialias!==null) expect(backing.antialias).toBe(true);
      expect([g.keyCount,g.minPitch,g.maxPitch]).toEqual([88,21,108]);
      expect(g.keyboardRect!.x).toBeLessThanOrEqual(2);
      expect(Math.abs(g.keyboardRect!.width-g.rendererSize.width)).toBeLessThanOrEqual(2);
      const header = page.getByTestId("studio-header");
      const handSelection = header.getByRole("group", {name: "Hand selection", exact: true});
      if(mode==="Performance") {
        await expect(page.locator(".fingering-toolbar")).toBeHidden();
        await expect(handSelection).toBeHidden();
      } else {
        await expect(page.locator(".fingering-toolbar")).toBeVisible();
        await expect(handSelection).toBeVisible();
        for (const name of ["Left Hand (L)", "Right Hand (R)", ...[1,2,3,4,5].map(f=>`Finger ${f}`), "Clear (0)", "Unplayable (Del)", "Gliss (G)"]) {
          const control = header.getByRole("button", {name, exact: true});
          await expect(control).toBeInViewport();
          const bounds = await control.boundingBox();
          const headerBounds = await header.boundingBox();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width + 1);
          expect(bounds!.y).toBeGreaterThanOrEqual(headerBounds!.y);
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(headerBounds!.y + headerBounds!.height + 1);
          await control.click({trial: true}); // Visible controls must also receive pointer input.
        }
        await expect(page.getByTestId("studio-workspace").getByRole("group", {name: "Hand selection", exact: true})).toHaveCount(0);
      }
      await page.screenshot({path:info.outputPath(`${size.width}x${size.height}-${mode.toLowerCase()}.png`)});
    }
    const trigger=page.getByRole("button",{name:"Projects",exact:true});
    await trigger.click();
    await expect(page.getByTestId("projects-panel")).toBeVisible();
    const beforeInput=await page.evaluate(()=>window.__playerSnapshot!.result.revision);
    await page.locator("#studio-project-search").fill("local");
    await page.locator("#studio-project-search").press("Space");
    await page.locator("#studio-project-search").press("Control+z");
    await expect(page.locator("#player-play-button")).toContainText("Play");
    expect((await settledStudio(page,0)).result.revision).toBe(beforeInput);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("projects-panel")).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  // Exercise both sides of header breakpoints, including the minimum width.
  for (const width of [320, 560, 900, 1600]) {
    await page.setViewportSize({width, height: 900});
    const header = page.getByTestId("studio-header");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    for (const control of await header.getByRole("button").all()) {
      const bounds = await control.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      if (await control.isEnabled()) await control.click({trial: true});
    }
    await page.screenshot({path:info.outputPath(`${width}x900-header-breakpoint.png`)});
  }
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await page.getByRole("button",{name:"Pin Projects panel",exact:true}).click();
  await expect.poll(async()=>{
    const panel=await page.getByTestId("projects-panel").boundingBox();
    const scene=await canvas.boundingBox();
    return Boolean(panel && scene && panel.x+panel.width<=scene.x+2 && scene.width>=960);
  }).toBe(true);
  await page.getByRole("button",{name:"Focus mode",exact:true}).click();
  await expect(page.getByTestId("projects-panel")).toBeHidden();
  await expect(canvas).toHaveAttribute("data-identity-probe","same-canvas");
  await page.getByRole("button",{name:"Focus mode",exact:true}).click();
  await expect(page.getByTestId("projects-panel")).toBeVisible();
  await page.setViewportSize({width:1024,height:768});
  await expect.poll(async()=>{
    const panel=await page.getByTestId("projects-panel").boundingBox();
    const scene=await canvas.boundingBox();
    return Boolean(panel && scene && panel.x+panel.width>scene.x+2);
  }).toBe(true);
  await page.setViewportSize(sizes[0]);
  await page.screenshot({path:info.outputPath("projects-pinned.png")});
  await page.getByRole("button",{name:"Close panel",exact:true}).click();
  await page.getByRole("button",{name:"Inspector",exact:true}).click();
  await page.screenshot({path:info.outputPath("inspector-scene.png")});
  await page.keyboard.press("Escape");
  const preferences=page.getByRole("button",{name:"Open preferences",exact:true});
  await preferences.click();
  await expect(page.getByRole("dialog",{name:"Preferences",exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath("preferences-workspace.png")});
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog",{name:"Preferences",exact:true})).toBeHidden();
  await expect(preferences).toBeFocused();
  expect(workers).toBe(stableWorkerCount);
  expect(errors).toEqual([]);
});

test("painted note editing survives commit, portable package and fresh browser context", async ({page,browser}) => {
  test.setTimeout(240_000);
  const imported=await loadStudioSong(page);
  await page.getByRole("button",{name:"Open pianist settings",exact:true}).click();
  await page.locator("#active-profile-select").selectOption("small-hands");
  await page.getByRole("dialog",{name:"Pianist settings",exact:true}).getByRole("button",{name:"Close",exact:true}).click();
  await openStudioInspector(page,"Scene");
  await page.locator("#studio-key-style").selectOption("equal");
  const initial=await settledStudio(page,imported.result.revision+2);
  await page.getByRole("button",{name:"Close panel",exact:true}).click();
  await page.getByRole("button",{name:"Fingering",exact:true}).click();
  // The stopped transport includes a two-second lead-in. Scroll the editor's
  // independent timeline to bring source notes into view, using its real UI.
  await page.locator("#piano-canvas-container canvas").hover();
  await page.mouse.wheel(0,400);
  await expect.poll(async()=>(await geometry(page)).notes.length).toBeGreaterThan(0);
  const g=await geometry(page);
  const note=g.notes.find(n=>n.rect.height>=8 && n.rect.y>=0 && n.rect.y+n.rect.height<g.keyboardRect!.y)!;
  expect(note).toBeDefined();
  const canvas=page.locator("#piano-canvas-container canvas");
  await canvas.click({position:{x:note.rect.x+note.rect.width/2,y:note.rect.y+note.rect.height/2}});
  await expect.poll(()=>page.evaluate(()=>window.__playerSnapshot!.editorSelectedNoteIds)).toEqual([note.noteId]);
  const previous=initial.result.fingeringPlan!.assignments.find(a=>a.noteId===note.noteId)!;
  const finger=previous.finger===4?3:4;
  await page.getByTestId("studio-header").getByRole("button",{name:`Finger ${finger}`,exact:true}).click();
  const edited=await settledStudio(page,initial.result.revision+1);
  await saveStudioProject(page);
  const file=await exportStudioPackage(page);
  const pkg=ProjectPackageSchema.parse(JSON.parse(await readFile(file,"utf8")));
  expect(pkg.packageVersion).toBe(2);
  expect(pkg.sourceContext.fixtureId).toBe("imported-midi");
  const source=pkg.resources.find(r=>r.resourceId===pkg.document.sourceMidiResourceId)!;
  expect(Buffer.from(pkg.resourcePayloads![source.path]!,"base64")).toEqual(await readFile(studioMidiPath));
  const fresh=await browser.newContext();
  try {
    const reopened=await fresh.newPage();
    await reopened.goto(new URL("/",page.url()).href);
    await expect(reopened.getByRole("button",{name:"Play demo song",exact:true})).toBeEnabled();
    await reopened.locator("#project-file").setInputFiles(file);
    await expect(reopened.locator("#piano-canvas-container canvas")).toBeVisible({timeout:90_000});
    const restored=await settledStudio(reopened,edited.result.revision);
    expect(restored.result.document!.notes.map(n=>n.noteId)).toEqual(edited.result.document!.notes.map(n=>n.noteId));
    expect(restored.profile).toEqual(edited.profile);
    const assignment=restored.result.fingeringPlan!.assignments.find(a=>a.noteId===note.noteId)!;
    expect(assignment.finger).toBe(finger);
    expect(assignment.fingerMode).toBe("manual");
    expect(restored.keyStyle).toBe(edited.keyStyle);
    expect(restored.viewMode).toBe("performance");
    await reopened.getByRole("button",{name:"Open pianist settings",exact:true}).click();
    await expect(reopened.locator("#active-profile-select")).toHaveValue("small-hands");
    await reopened.keyboard.press("Escape");
  } finally { await fresh.close(); }
});

test("invalid packages retain the active scene and committed project",async({page})=>{
  test.setTimeout(180_000);
  const initial=await loadStudioSong(page);
  await saveStudioProject(page);
  const canvas=page.locator("#piano-canvas-container canvas");
  await canvas.evaluate(el=>el.setAttribute("data-identity-probe","retained"));
  const exported=await exportStudioPackage(page);
  const pkg=JSON.parse(await readFile(exported,"utf8"));
  for(const [name,value] of [["malformed.json",{packageVersion:2}],["missing-bytes.json",{...pkg,resourcePayloads:{}}]]){
    await page.locator("#project-file").setInputFiles({name:name as string,mimeType:"application/json",buffer:Buffer.from(JSON.stringify(value))});
    await expect(page.getByTestId("studio-status")).toContainText(/failed|error|missing|required|invalid/i);
    await expect(canvas).toHaveAttribute("data-identity-probe","retained");
    expect((await settledStudio(page,0)).result.document).toEqual(initial.result.document);
  }
});

test("an IndexedDB abort after request success never announces a committed save",async({page})=>{
  test.setTimeout(150_000);
  const initial=await loadStudioSong(page);
  await page.evaluate(()=>{
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore["put"]>){
      const request=original.apply(this,args);
      if(this.name==="projects") {
        request.addEventListener("success",()=>{
          IDBObjectStore.prototype.put=original;
          request.transaction?.abort();
        },{once:true});
      }
      return request;
    };
  });
  await page.getByRole("button",{name:"File",exact:true}).click();
  await page.getByRole("menuitem",{name:"Save project",exact:true}).click();
  await expect(page.getByTestId("studio-status")).toContainText(/failed|abort|error/i);
  await expect(page.getByTestId("studio-status")).not.toContainText(/project saved/i);
  const record=await page.evaluate(async projectId=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
      const request=indexedDB.open("handthesia_db",2);
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    try {
      return await new Promise<unknown>((resolve,reject)=>{
        const request=db.transaction("projects","readonly").objectStore("projects").get(projectId);
        request.onsuccess=()=>resolve(request.result??null);request.onerror=()=>reject(request.error);
      });
    } finally {db.close();}
  },initial.result.projectId);
  expect(record).toBeNull();
  expect((await settledStudio(page,0)).result.document).toEqual(initial.result.document);
});

test("legacy geometry is explicit, engine changes replan, and failed candidate replan retains the scene",async({page})=>{
  test.setTimeout(360_000);
  const initial=await loadStudioSong(page);
  await saveStudioProject(page);
  const original=JSON.parse(await readFile(await exportStudioPackage(page),"utf8"));
  const legacy={...original,packageVersion:1};delete legacy.sourceContext;
  await page.locator("#project-file").setInputFiles({name:"legacy.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(legacy))});
  const dialog=page.getByRole("alertdialog",{name:"Choose the original keyboard geometry",exact:true});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button",{name:"Verify and open",exact:true})).toBeDisabled();
  await dialog.getByLabel("Equal key widths",{exact:true}).check();
  await dialog.getByRole("button",{name:"Verify and open",exact:true}).click();
  await page.waitForFunction(id=>window.__playerSnapshot?.result.projectId!==id,initial.result.projectId,{timeout:120_000});
  const migrated=await settledStudio(page,0);
  expect(migrated.keyStyle).toBe("equal");
  expect(migrated.result.document!.notes.map(n=>n.noteId)).toEqual(initial.result.document!.notes.map(n=>n.noteId));
  await saveStudioProject(page);
  const stale=structuredClone(original);
  for(const key of ["fingeringPlan","performancePlan","motionPlan"]) if(stale[key]) stale[key].engineVersion="older-engine";
  await page.locator("#project-file").setInputFiles({name:"older-engine.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(stale))});
  await page.waitForFunction(id=>window.__playerSnapshot?.result.projectId!==id,migrated.result.projectId,{timeout:120_000});
  const updated=await settledStudio(page,0);
  expect(updated.result.engineVersion).toBe(initial.result.engineVersion);
  expect(updated.result.fingeringPlan!.engineVersion).toBe(initial.result.engineVersion);
  expect(updated.result.document!.notes.map(n=>n.noteId)).toEqual(initial.result.document!.notes.map(n=>n.noteId));
  await saveStudioProject(page);
  const canvas=page.locator("#piano-canvas-container canvas");
  await canvas.evaluate(el=>el.setAttribute("data-identity-probe","before-failed-replan"));
  await page.evaluate(()=>{
    const originalPost=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(message:unknown,options:StructuredSerializeOptions|Transferable[]=[]){
      const request=message as {type?:string;midiBytes?:ArrayBuffer};
      if(request?.type==="replan-document") {
        Worker.prototype.postMessage=originalPost;
        // Force rejection by the real Worker at candidate replan, after its
        // source analysis succeeded. No fabricated success response is used.
        if(request.midiBytes) new Uint8Array(request.midiBytes)[0]^=1;
      }
      Reflect.apply(originalPost,this,[message,options]);
    };
  });
  await page.locator("#project-file").setInputFiles({name:"replan-fault.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(original))});
  await expect(page.getByTestId("studio-status")).toContainText(/not opened|failed|invalid/i,{timeout:120_000});
  await expect(canvas).toHaveAttribute("data-identity-probe","before-failed-replan");
  expect((await settledStudio(page,0)).result.document).toEqual(updated.result.document);
});
