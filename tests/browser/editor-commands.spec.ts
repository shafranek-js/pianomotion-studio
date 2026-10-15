import { expect, test } from "@playwright/test";
import { focusStudioScene, loadStudioSong, openStudioEditMenu, settledStudio } from "./studio-helpers";

test("Help works before opening a project and restores focus after shortcuts", async ({page}) => {
  await page.goto("/");
  await expect(page.getByRole("button", {name:"Play demo song", exact:true})).toBeEnabled();
  const help=page.getByRole("button", {name:"Help", exact:true});
  await help.click();
  await page.getByRole("menuitem", {name:"Keyboard shortcuts", exact:true}).click();
  const dialog=page.getByRole("dialog", {name:"Keyboard shortcuts", exact:true});
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Ctrl");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(help).toBeFocused();
  await page.getByRole("button", {name:"Edit", exact:true}).click();
  await expect(page.getByRole("menuitem", {name:/^Undo/})).toBeDisabled();
  await expect(page.getByRole("menuitem", {name:/^Redo/})).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", {name:"Edit", exact:true})).toBeFocused();
});

test("Auto-advance confirms fingers without fictitious edits and menus share the editor history", async ({page}) => {
  test.setTimeout(240_000);
  const errors:string[]=[];page.on("pageerror", error=>errors.push(error.message));
  const initial=await loadStudioSong(page);
  const canvas=await focusStudioScene(page);
  await canvas.evaluate(el=>el.setAttribute("data-commands-probe", "same-canvas"));
  await page.getByRole("button", {name:"Fingering", exact:true}).click();
  await expect(page.getByTestId("studio-editor-toolbar")).toHaveCount(0);
  await expect(page.getByRole("button", {name:/^Undo/})).toHaveCount(0);
  await expect(page.getByRole("button", {name:/^Redo/})).toHaveCount(0);
  const header=page.getByTestId("studio-header");
  const auto=header.getByRole("button", {name:/^Auto-advance/});
  await expect(auto).toHaveAttribute("aria-pressed", "false");
  const notes=[...initial.result.document!.notes].sort((a,b)=>a.startSeconds-b.startSeconds || a.pitch-b.pitch);
  const selected=()=>page.evaluate(()=>window.__playerSnapshot!.editorSelectedNoteIds);
  await focusStudioScene(page);await page.keyboard.press("ArrowRight");
  await expect.poll(selected).toEqual([notes[0]!.noteId]);
  await header.getByRole("button", {name:"Finger 4", exact:true}).click();
  const first=await settledStudio(page, initial.result.revision+1);
  await expect.poll(selected).toEqual([notes[0]!.noteId]); // Default is off.
  await auto.click();
  await expect(auto).toHaveAttribute("aria-pressed", "true");
  const hand=first.result.fingeringPlan!.assignments.find(a=>a.noteId===notes[0]!.noteId)!.hand;
  await header.getByRole("button", {name:hand==="left"?"Right Hand (R)":"Left Hand (L)", exact:true}).click();
  const changedHand=await settledStudio(page, first.result.revision+1);
  await expect.poll(selected).toEqual([notes[0]!.noteId]); // Hand assignment does not advance.
  await header.getByRole("button", {name:"Finger 4", exact:true}).click();
  await expect.poll(selected).toEqual([notes[1]!.noteId]); // Confirming a manual finger advances.
  await page.waitForTimeout(650); // Beyond the edit debounce: a no-op must not replan.
  const confirmed=await settledStudio(page, changedHand.result.revision);
  expect(confirmed.result.revision).toBe(changedHand.result.revision);
  expect(confirmed.result.performancePlan!.planId).toBe(changedHand.result.performancePlan!.planId);
  await header.getByRole("button", {name:"Finger 3", exact:true}).click();
  const second=await settledStudio(page, confirmed.result.revision+1);
  await expect.poll(selected).toEqual([notes[2]!.noteId]);
  await page.keyboard.press("Control+z"); // Finger button still has focus.
  const undone=await settledStudio(page, second.result.revision+1);
  expect(undone.result.fingeringPlan!.assignments.find(a=>a.noteId===notes[1]!.noteId)?.fingerMode).not.toBe("manual");
  await openStudioEditMenu(page);
  await expect(page.getByRole("menuitem", {name:/^Redo/})).toBeEnabled();
  await page.getByRole("menuitem", {name:/^Redo/}).click();
  const redone=await settledStudio(page, undone.result.revision+1);
  expect(redone.result.fingeringPlan!.assignments.find(a=>a.noteId===notes[1]!.noteId)?.finger).toBe(3);
  await page.getByRole("button", {name:"Projects", exact:true}).click();
  await expect(page.getByTestId("projects-panel")).toBeVisible();
  const help=page.getByRole("button", {name:"Help", exact:true});
  await help.click();
  await page.getByRole("menuitem", {name:"Keyboard shortcuts", exact:true}).click();
  const dialog=page.getByRole("dialog", {name:"Keyboard shortcuts", exact:true});
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  // Exercise reading the help, not Space's native activation of its Close button.
  await dialog.focus();
  await page.keyboard.press("Control+z");await page.keyboard.press("Space");await page.keyboard.press("1");
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(650);
  await expect(page.locator("#player-play-button")).toContainText("Play");
  expect((await settledStudio(page, redone.result.revision)).result.revision).toBe(redone.result.revision);
  await page.keyboard.press("Escape");await expect(help).toBeFocused();
  await expect(page.getByTestId("projects-panel")).toBeVisible(); // Escape closes only the top layer.
  await page.getByRole("button", {name:"Close panel", exact:true}).click();
  await page.getByRole("button", {name:"Performance", exact:true}).click();
  await expect(auto).toBeHidden();
  await openStudioEditMenu(page);
  await expect(page.getByRole("menuitem", {name:/^Undo/})).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name:"Fingering", exact:true}).click();
  await expect(auto).toHaveAttribute("aria-pressed", "true");
  await expect(canvas).toHaveAttribute("data-commands-probe", "same-canvas");
  expect(errors).toEqual([]);
});
