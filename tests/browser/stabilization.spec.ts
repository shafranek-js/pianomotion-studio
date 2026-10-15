import {expect,test} from "@playwright/test";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {ProjectPackageSchema} from "@handthesia/contracts";
import {exportStudioPackage,focusStudioScene,loadStudioSong,openStudioInspector,saveStudioProject,settledStudio} from "./studio-helpers";

test("selection does not calculate; edits preserve IDs/history and exported MIDI markers",async({page})=>{
  test.setTimeout(240_000);
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  let workers=0;page.on("worker",()=>workers++);
  const initial=await loadStudioSong(page);
  await page.getByRole("button",{name:"Fingering",exact:true}).click();
  await focusStudioScene(page);await page.keyboard.press("ArrowRight");
  const count=workers;
  await page.waitForTimeout(650); // Longer than the real edit debounce.
  expect(workers).toBe(count);
  expect((await settledStudio(page,0)).result.revision).toBe(initial.result.revision);
  const toolbar=page.locator(".fingering-toolbar");
  await page.getByTestId("studio-header").getByRole("button",{name:"Finger 4",exact:true}).click();
  const edited=await settledStudio(page,initial.result.revision+1);
  expect(edited.result.document!.notes.map(n=>n.noteId)).toEqual(initial.result.document!.notes.map(n=>n.noteId));
  const pin=edited.result.fingeringPlan!.assignments.find(a=>a.fingerMode==="manual" && a.finger===4)!;
  expect(pin).toBeDefined();
  await page.locator("#player-play-button").click();
  await page.getByTestId("studio-header").getByRole("button",{name:"Finger 3",exact:true}).click();
  const second=await settledStudio(page,edited.result.revision+1);
  await expect(page.locator("#player-play-button")).toContainText("Pause");
  expect(second.result.document!.notes.find(n=>n.noteId===pin.noteId)?.finger).toBe(3);
  await page.locator("#player-play-button").click();
  const paused=Number(await page.locator("#player-seek-slider").inputValue());
  await toolbar.getByRole("button",{name:"Undo",exact:true}).click();
  const undone=await settledStudio(page,second.result.revision+1);
  expect(undone.result.document!.notes.find(n=>n.noteId===pin.noteId)?.finger).toBe(4);
  expect(Math.abs(Number(await page.locator("#player-seek-slider").inputValue())-paused)).toBeLessThan(.1);
  await saveStudioProject(page);
  await page.getByRole("button",{name:"Export",exact:true}).click();
  const event=page.waitForEvent("download");
  await page.getByRole("menuitem",{name:"Fingered MIDI (.mid)",exact:true}).click();
  const download=await event;
  const file=await download.path();expect(file).not.toBeNull();
  await page.locator("#midi-file").setInputFiles({name:download.suggestedFilename(),mimeType:"audio/midi",buffer:await readFile(file!)});
  await page.waitForFunction(id=>window.__playerSnapshot?.result.projectId!==id,initial.result.projectId);
  const imported=await settledStudio(page,0);
  const source=undone.result.document!.notes.find(n=>n.noteId===pin.noteId)!;
  expect(imported.result.document!.notes.find(n=>n.pitch===source.pitch && n.startSeconds===source.startSeconds)?.finger).toBe(4);
  expect(errors).toEqual([]);
});

test("latest profile/equal geometry survive package bytes and session recovery",async({page})=>{
  test.setTimeout(240_000);
  const initial=await loadStudioSong(page);
  await page.getByRole("button",{name:"Open pianist settings",exact:true}).click();
  await page.locator("#active-profile-select").selectOption("virtuoso");
  await page.locator("#active-profile-select").selectOption("small-hands");
  await page.getByRole("dialog",{name:"Pianist settings",exact:true}).getByRole("button",{name:"Close",exact:true}).click();
  await openStudioInspector(page,"Scene");
  await page.locator("#studio-key-style").selectOption("equal");
  const applied=await settledStudio(page,initial.result.revision+2);
  expect(applied.profile.profileId).toBe("small-hands");
  expect(applied.result.fingeringPlan!.profileId).toBe("small-hands");
  expect(applied.keyStyle).toBe("equal");
  expect(applied.result.document!.notes.map(n=>n.noteId)).toEqual(initial.result.document!.notes.map(n=>n.noteId));
  expect(applied.result.motionPlan).not.toEqual(initial.result.motionPlan);
  await page.getByRole("button",{name:"Close panel",exact:true}).click();
  const file=await exportStudioPackage(page);
  const pkg=ProjectPackageSchema.parse(JSON.parse(await readFile(file,"utf8")));
  const resource=pkg.resources.find(r=>r.resourceId===pkg.document.sourceMidiResourceId)!;
  const bytes=Buffer.from(pkg.resourcePayloads![resource.path]!,"base64");
  expect(bytes.length).toBe(resource.byteLength);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(resource.sha256);
  expect(pkg.sourceContext.keyStyle).toBe("equal");
  await page.getByRole("button",{name:"Fingering",exact:true}).click();
  await expect.poll(async()=>page.evaluate(async()=>{
    const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open("handthesia_db",2);r.onsuccess=()=>resolve(r.result);});
    try{return await new Promise<{viewMode:string;plansState:string}>(resolve=>{const r=db.transaction("session").objectStore("session").get("current_session");r.onsuccess=()=>resolve({viewMode:r.result?.viewMode,plansState:r.result?.plansState});});}
    finally{db.close();}
  }),{timeout:15_000}).toEqual({viewMode:"editor",plansState:"valid"});
  await page.reload();
  const restored=await settledStudio(page,applied.result.revision);
  expect(restored.result.document).toEqual(applied.result.document);
  expect(restored.result.fingeringPlan!.assignments).toEqual(applied.result.fingeringPlan!.assignments);
  expect(restored.profile).toEqual(applied.profile);
  expect(restored.keyStyle).toBe("equal");
  expect(restored.viewMode).toBe("editor");
});

test("autosaved pending intent is recovered and replanned after reload",async({page})=>{
  test.setTimeout(240_000);
  const initial=await loadStudioSong(page);
  // Delay sending a real replan, rather than relying on a second manifest fetch
  // which the persistent, already initialized Worker correctly no longer needs.
  await page.evaluate(()=>{
    const original=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(message:unknown,options:StructuredSerializeOptions|Transferable[]=[]){
      const send=()=>Reflect.apply(original,this,[message,options]);
      if((message as {type?:string})?.type==="replan-document") setTimeout(send,2500);
      else send();
    };
  });
  await page.getByRole("button",{name:"Fingering",exact:true}).click();
  await focusStudioScene(page);await page.keyboard.press("ArrowRight");
  await page.getByTestId("studio-header").getByRole("button",{name:"Finger 4",exact:true}).click();
  await expect.poll(async()=>page.evaluate(async()=>{
    const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open("handthesia_db",2);r.onsuccess=()=>resolve(r.result);});
    try{return await new Promise<{state:string;revision:number}>(resolve=>{const r=db.transaction("session").objectStore("session").get("current_session");r.onsuccess=()=>resolve({state:r.result?.plansState,revision:r.result?.draftFingeringPlan?.inputRevision});});}
    finally{db.close();}
  }),{timeout:10_000}).toEqual({state:"recompute-required",revision:initial.result.revision+1});
  const pending=await page.evaluate(()=>window.__playerSnapshot!.draftPlan);
  const pin=pending.assignments.find(a=>a.fingerMode==="manual" && a.finger===4)!;expect(pin).toBeDefined();
  await page.reload();
  const restored=await settledStudio(page,pending.inputRevision);
  const assignment=restored.result.fingeringPlan!.assignments.find(a=>a.noteId===pin.noteId)!;
  expect(assignment.finger).toBe(4);expect(assignment.fingerMode).toBe("manual");
});
