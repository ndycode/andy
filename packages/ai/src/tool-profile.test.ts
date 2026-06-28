import { describe, expect, test } from "bun:test";
import { selectToolProfile } from "./tool-profile";

describe("tool profile selection", () => {
  test("uses narrow profiles for obvious single-intent turns", () => {
    expect(selectToolProfile("hello")).toBe("chat");
    expect(selectToolProfile("grab 180")).toBe("logWrite");
    expect(selectToolProfile("rent 8k")).toBe("logWrite");
    expect(selectToolProfile("iced matcha 120")).toBe("logWrite");
    expect(selectToolProfile("how am i doing this month?")).toBe("readBasic");
    expect(selectToolProfile("what did i spend recently?")).toBe("readBasic");
    expect(selectToolProfile("remember i get paid every 15th")).toBe("memory");
    expect(selectToolProfile("what do you know about me?")).toBe("memoryRead");
    expect(selectToolProfile("show my memories")).toBe("memoryRead");
    expect(selectToolProfile("forget my payday memory")).toBe("memory");
    expect(selectToolProfile("save 20k for japan by december")).toBe("goalCreate");
    expect(selectToolProfile("put away 50k for emergency")).toBe("goalCreate");
    expect(selectToolProfile("put 1k to japan")).toBe("goalContribute");
    expect(selectToolProfile("i saved 1000 for laptop last tuesday")).toBe("goalContribute");
    expect(selectToolProfile("how's my laptop fund?")).toBe("goalRead");
    expect(selectToolProfile("am i on track for japan fund?")).toBe("goalRead");
    expect(selectToolProfile("delete my laptop goal?")).toBe("goalManage");
    expect(selectToolProfile("make laptop goal 30k?")).toBe("goalManage");
    expect(selectToolProfile("put 1k to japan, actually 2k")).toBe("goal");
    expect(selectToolProfile("budget 5k for food")).toBe("budget");
    expect(selectToolProfile("how are my budgets?")).toBe("budgetRead");
    expect(selectToolProfile("budget check")).toBe("budgetRead");
    expect(selectToolProfile("drop the food budget")).toBe("budget");
    expect(selectToolProfile("budget 5k for food and how are my budgets?")).toBe("budget");
    expect(selectToolProfile("rent 8k every 1st")).toBe("recurring");
    expect(selectToolProfile("what are my recurring bills?")).toBe("recurringRead");
    expect(selectToolProfile("show my recurring reminders")).toBe("recurringRead");
    expect(selectToolProfile("cancel rent recurring")).toBe("recurring");
    expect(selectToolProfile("change rent reminder to 9k")).toBe("recurring");
    expect(selectToolProfile("delete that")).toBe("logEdit");
    expect(selectToolProfile("actually 200")).toBe("logEdit");
    expect(selectToolProfile("no wait make it 200")).toBe("logEdit");
    expect(selectToolProfile("grab 180, no make it 200")).toBe("log");
  });

  test("uses focused read profiles for single analysis intents", () => {
    expect(selectToolProfile("biggest expense this month")).toBe("readSearch");
    expect(selectToolProfile("anything over 1k on food")).toBe("readSearch");
    expect(selectToolProfile("find that grab last week")).toBe("readSearch");
    expect(selectToolProfile("compare this month vs last month")).toBe("readCompare");
    expect(selectToolProfile("spending pace for food")).toBe("readPace");
    expect(selectToolProfile("am i gonna blow my food budget?")).toBe("readPace");
    expect(selectToolProfile("where's my money leaking?")).toBe("readInsight");
    expect(selectToolProfile("weekday vs weekend patterns")).toBe("read");
  });

  test("falls back to full profile for mixed turns that need multiple tool families", () => {
    expect(selectToolProfile("grab 180 and how am i doing")).toBe("full");
    expect(selectToolProfile("grab 180 and how am i doing?")).toBe("full");
    expect(selectToolProfile("budget 5k for food and how am i doing?")).toBe("full");
  });
});
