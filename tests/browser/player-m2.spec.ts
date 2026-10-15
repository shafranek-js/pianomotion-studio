import {expect,test} from "@playwright/test";
import {loadStudioSong,openStudioInspector,saveStudioProject,settledStudio} from "./studio-helpers";

test("studio playback, geometry replan and committed project persistence",async({page})=>{
  test.setTimeout(180_000);
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  const initial=await loadStudioSong(page);
  const play=page.locator("#player-play-button");
  const seek=page.locator("#player-seek-slider");
  await play.click();
  await expect(play).toContainText("Pause");
  await expect.poll(async()=>Number(await seek.inputValue())).toBeGreaterThan(-1.5);
  await play.click();
  await expect(play).toContainText("Play");
  await page.locator("#player-stop-button").click();
  expect(Number(await seek.inputValue())).toBeLessThanOrEqual(-1.9);
  await page.locator("#player-speed-select").selectOption("1.25");
  await openStudioInspector(page,"Scene");
  await page.locator("#studio-key-style").selectOption("equal");
  const applied=await settledStudio(page,initial.result.revision);
  await expect.poll(()=>page.evaluate(()=>window.__playerSnapshot!.keyStyle)).toBe("equal");
  await page.getByRole("button",{name:"Close panel",exact:true}).click();
  await saveStudioProject(page);
  const record=await page.evaluate(async id=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open("handthesia_db",2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    try{return await new Promise<{projectId:string;sourceContext:{keyStyle:string}}>((resolve,reject)=>{const r=db.transaction("projects").objectStore("projects").get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
    finally{db.close();}
  },applied.result.projectId);
  expect(record.projectId).toBe(applied.result.projectId);
  expect(record.sourceContext.keyStyle).toBe("equal");
  expect(errors).toEqual([]);
});
