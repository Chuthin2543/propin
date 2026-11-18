// =====================================================
// vehicle-store.ts — อ่าน/เขียนข้อมูลลงไฟล์ (ทำงานฝั่งเซิร์ฟเวอร์เท่านั้น ใช้ใน API)
//
// ข้อมูลเก็บในโฟลเดอร์ .data ของโปรเจกต์ (สร้างให้เองตอนเปิดครั้งแรก)
//   .data/vehicles.json  ข้อมูลรถทุกคัน
//   .data/rates.json     อัตราค่าจอด + ประวัติการแก้ไข
//   .data/maintenance.json  ช่องที่ปิดซ่อม
//   .data/lot.json       ลานจอดมีกี่ชั้น แต่ละชั้นมีแถวไหน ช่องไหน
// ทุกเครื่องที่เปิดเว็บนี้ จึงเห็นข้อมูลชุดเดียวกัน
//
// ⚠️ ถ้านำขึ้นโฮสต์อย่าง Vercel ไฟล์จะไม่ถูกเก็บถาวร ต้องเปลี่ยนเป็นฐานข้อมูลจริง
// =====================================================
import { promises as fs } from "fs";
import path from "path";
import { seedVehicles, type Vehicle } from "./vehicles";
import { DEFAULT_RATES, sanitizeRates, type Rates } from "./fee";
import { RATE_HISTORY } from "./data";
import { DEFAULT_LAYOUT, normalizeLayout, type LotFloor, type MaintenanceItem } from "./lot";

const DATA_FOLDER = path.join(process.cwd(), ".data");
const VEHICLES_FILE = path.join(DATA_FOLDER, "vehicles.json");
const RATES_FILE = path.join(DATA_FOLDER, "rates.json");
const MAINTENANCE_FILE = path.join(DATA_FOLDER, "maintenance.json");
const LAYOUT_FILE = path.join(DATA_FOLDER, "lot.json");

// ---------------- อ่าน/เขียนไฟล์ JSON ----------------

/** บันทึกข้อมูลลงไฟล์ (เขียนไฟล์ชั่วคราวก่อน แล้วค่อยเปลี่ยนชื่อ → ไฟล์ไม่เสียถ้าเซิร์ฟเวอร์ดับกลางทาง) */
async function saveJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(DATA_FOLDER, { recursive: true });
  const tempFile = file + ".tmp";
  await fs.writeFile(tempFile, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tempFile, file);
}

/** อ่านไฟล์ ถ้ายังไม่มีไฟล์ → สร้างจากข้อมูลตั้งต้นที่ให้มา */
async function loadJson<T>(file: string, makeDefault: () => T): Promise<T> {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text) as T;
  } catch {
    const data = makeDefault();
    await saveJson(file, data);
    return data;
  }
}

// ---------------- คิวงาน: ให้แก้ข้อมูลทีละคำขอ ----------------
// ถ้ามี 2 เครื่องบันทึกพร้อมกัน แล้วต่างคนต่างอ่าน-แก้-เขียน ข้อมูลของคนหนึ่งจะหาย
// จึงให้ทุกงานแก้ข้อมูลต่อคิวกัน ทำเสร็จทีละงาน
// (เก็บคิวไว้ใน globalThis เพื่อให้ทุกไฟล์ API ใช้คิวเดียวกัน)

const shared = globalThis as unknown as { saveQueue?: Promise<unknown> };

function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const previous = shared.saveQueue ?? Promise.resolve();
  const current = previous.then(job);
  shared.saveQueue = current.catch(() => undefined); // งานนี้พังก็ไม่ทำให้คิวค้าง
  return current;
}

// ---------------- ข้อมูลรถ ----------------

/** อ่านรถทั้งหมด */
export function readVehicles(): Promise<Vehicle[]> {
  return loadJson(VEHICLES_FILE, () => seedVehicles());
}

/**
 * แก้ข้อมูลรถแบบปลอดภัย (ต่อคิว)
 * ฟังก์ชัน change ได้รายการรถปัจจุบัน แล้วคืนค่า:
 *   { save: รายการใหม่ (ถ้าต้องการบันทึก), reply: ค่าที่จะส่งกลับ }
 */
export function updateVehicles<T>(change: (list: Vehicle[]) => { save?: Vehicle[]; reply: T }): Promise<T> {
  return oneAtATime(async () => {
    const list = await readVehicles();
    const result = change(list);
    if (result.save) {
      await saveJson(VEHICLES_FILE, result.save);
    }
    return result.reply;
  });
}

/** ล้างข้อมูลรถกลับเป็นรถตัวอย่าง */
export function resetVehicles(): Promise<Vehicle[]> {
  return oneAtATime(async () => {
    const list = seedVehicles();
    await saveJson(VEHICLES_FILE, list);
    return list;
  });
}

// ---------------- อัตราค่าจอด ----------------

export type RateHistoryItem = { what: string; who: string; when: string };
export type RatesData = { rates: Rates; history: RateHistoryItem[] };

function defaultRatesData(): RatesData {
  return { rates: DEFAULT_RATES, history: RATE_HISTORY };
}

/** อ่านอัตราค่าจอด + ประวัติ */
export async function readRates(): Promise<RatesData> {
  const data = await loadJson(RATES_FILE, defaultRatesData);
  return {
    rates: sanitizeRates(data.rates ?? {}),
    history: data.history ?? [],
  };
}

/** แก้อัตราค่าจอดแบบปลอดภัย (ต่อคิว) */
export function updateRates(change: (data: RatesData) => RatesData): Promise<RatesData> {
  return oneAtATime(async () => {
    const next = change(await readRates());
    await saveJson(RATES_FILE, next);
    return next;
  });
}

/** คืนอัตราค่าจอดเป็นค่าเริ่มต้น */
export function resetRates(): Promise<RatesData> {
  return oneAtATime(async () => {
    const data = defaultRatesData();
    await saveJson(RATES_FILE, data);
    return data;
  });
}

// ---------------- ช่องที่ปิดซ่อม ----------------

/** อ่านรายการช่องที่ปิดซ่อม (เริ่มต้น = ไม่มี) */
export function readMaintenance(): Promise<MaintenanceItem[]> {
  return loadJson<MaintenanceItem[]>(MAINTENANCE_FILE, () => []);
}

/** แก้รายการช่องที่ปิดซ่อมแบบปลอดภัย (ต่อคิว) */
export function updateMaintenance<T>(change: (list: MaintenanceItem[]) => { save?: MaintenanceItem[]; reply: T }): Promise<T> {
  return oneAtATime(async () => {
    const result = change(await readMaintenance());
    if (result.save) {
      await saveJson(MAINTENANCE_FILE, result.save);
    }
    return result.reply;
  });
}

/** ล้างรายการช่องซ่อมทั้งหมด */
export function resetMaintenance(): Promise<MaintenanceItem[]> {
  return oneAtATime(async () => {
    await saveJson(MAINTENANCE_FILE, []);
    return [];
  });
}

// ---------------- ชั้นของลานจอด ----------------

/** อ่านการตั้งค่าชั้น (เริ่มต้น = 3 ชั้น ชั้นละ 16 ช่อง) */
export async function readLayout(): Promise<LotFloor[]> {
  const raw = await loadJson<unknown>(LAYOUT_FILE, () => DEFAULT_LAYOUT);
  return normalizeLayout(raw); // แปลงไฟล์จากเวอร์ชันก่อน (ที่เก็บแค่จำนวนช่อง) ให้เป็นแถว
}

/** แก้การตั้งค่าชั้นแบบปลอดภัย (ต่อคิว) */
export function updateLayout<T>(change: (layout: LotFloor[]) => { save?: LotFloor[]; reply: T }): Promise<T> {
  return oneAtATime(async () => {
    const result = change(await readLayout());
    if (result.save) {
      await saveJson(LAYOUT_FILE, result.save);
    }
    return result.reply;
  });
}

/** คืนการตั้งค่าชั้นเป็นค่าเริ่มต้น */
export function resetLayout(): Promise<LotFloor[]> {
  return oneAtATime(async () => {
    await saveJson(LAYOUT_FILE, DEFAULT_LAYOUT);
    return DEFAULT_LAYOUT;
  });
}
