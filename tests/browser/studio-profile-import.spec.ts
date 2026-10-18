import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ProjectPackageSchema } from "@handthesia/contracts";
import { expectStudioCanvas, exportStudioPackage, loadStudioSong, saveStudioProject, settledStudio } from "./studio-helpers";

test("a package-only profile can be edited, duplicated, and reopened from saved projects", async ({page,browser},info) => {
  test.setTimeout(240_000);
  await loadStudioSong(page);
  const pkg = ProjectPackageSchema.parse(JSON.parse(await readFile(await exportStudioPackage(page),"utf8")));
  const profile = {...pkg.profiles[0]!,profileId:"package-only-profile",name:"Imported anatomy",revision:8};
  pkg.profiles = [profile];
  pkg.activeProfileId = profile.profileId;
  for (const key of ["fingeringPlan","performancePlan","motionPlan"]) {
    const plan = pkg[key as "fingeringPlan"|"performancePlan"|"motionPlan"];
    if(plan) Object.assign(plan,{profileId:profile.profileId,profileRevision:profile.revision});
  }
  ProjectPackageSchema.parse(pkg);
  const context = await browser.newContext();
  try {
    const fresh = await context.newPage();
    await fresh.goto(new URL("/?empty=true",page.url()).href);
    await expect(fresh.getByRole("button",{name:"Play demo song",exact:true})).toBeEnabled();
    await fresh.locator("#project-file").setInputFiles({name:"custom-profile.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(pkg))});
    await expectStudioCanvas(fresh, 90_000);
    const imported = await settledStudio(fresh,0);
    await fresh.getByRole("button",{name:"Open pianist settings",exact:true}).click();
    const dialog = fresh.getByRole("dialog",{name:"Pianist settings",exact:true});
    await expect(fresh.locator("#active-profile-select")).toHaveValue("package-only-profile");
    const slider = dialog.getByRole("slider").first();
    const before = await slider.inputValue();
    await slider.press("ArrowRight");
    expect(await slider.inputValue()).not.toBe(before);
    await dialog.getByRole("button",{name:"Save & Apply",exact:true}).click();
    await expect(dialog).toContainText("Profile saved & applied!");
    await fresh.keyboard.press("Escape");
    const edited = await settledStudio(fresh,imported.result.revision+1);
    expect(edited.profile.profileId).toBe(imported.profile.profileId);
    expect(edited.profile.revision).toBeGreaterThan(imported.profile.revision);
    expect(edited.profile.anatomy).not.toEqual(imported.profile.anatomy);
    await fresh.getByRole("button",{name:"Open pianist settings",exact:true}).click();
    await dialog.getByRole("button",{name:"Duplicate",exact:true}).click();
    await expect(fresh.locator("#active-profile-select")).not.toHaveValue("package-only-profile");
    await fresh.screenshot({path:info.outputPath("imported-pianist-workspace.png")});
    await fresh.keyboard.press("Escape");
    const cloned = await settledStudio(fresh,edited.result.revision+1);
    expect(cloned.profile.anatomy).toEqual(edited.profile.anatomy);
    expect(cloned.profile.profileId).not.toBe(edited.profile.profileId);
    await saveStudioProject(fresh);
    await fresh.getByRole("button",{name:"Fingering",exact:true}).click();
    await fresh.getByRole("button",{name:"File",exact:true}).click();
    await fresh.getByRole("menuitem",{name:"Open saved project…",exact:true}).click();
    await expect(fresh.getByTestId("projects-panel")).toBeVisible();
    await fresh.getByTestId("studio-project-row").getByRole("button").first().click();
    await expect(fresh.getByTestId("studio-status")).toContainText(/opened/i,{timeout:90_000});
    const reopened = await settledStudio(fresh,cloned.result.revision);
    expect(reopened.result.document).toEqual(cloned.result.document);
    expect(reopened.profile).toEqual(cloned.profile);
    expect(reopened.viewMode).toBe("performance");
  } finally {await context.close();}
});
