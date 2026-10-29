import { parse } from 'opentype.js';
import cursive from './fonts/hershey/cursive.jhf?raw';
import futural from './fonts/hershey/futural.jhf?raw';
import gothiceng from './fonts/hershey/gothiceng.jhf?raw';
import rowmand from './fonts/hershey/rowmand.jhf?raw';
import scripts from './fonts/hershey/scripts.jhf?raw';
import timesi from './fonts/hershey/timesi.jhf?raw';
import timesr from './fonts/hershey/timesr.jhf?raw';
import abril from './fonts/outline/AbrilFatface-Regular.ttf?url';
import bebas from './fonts/outline/BebasNeue-Regular.ttf?url';
import bungee from './fonts/outline/Bungee-Regular.ttf?url';
import pacifico from './fonts/outline/Pacifico-Regular.ttf?url';
import { hersheyFont } from './hershey';
import { outlineFont } from './outline-font';
import type { TextFont } from './text-layout';

// Loads the bundled fonts by id. Hershey data is small and built in; outline
// font files are separate assets fetched from this site on first use.

const HERSHEY: Record<string, string> = {
  'hershey-sans': futural,
  'hershey-sans-bold': rowmand,
  'hershey-serif': timesr,
  'hershey-serif-italic': timesi,
  'hershey-script': scripts,
  'hershey-cursive': cursive,
  'hershey-gothic': gothiceng,
};

const OUTLINE: Record<string, string> = {
  'bebas-neue': bebas,
  'abril-fatface': abril,
  bungee,
  pacifico,
};

export async function loadBundledFont(id: string): Promise<TextFont> {
  if (HERSHEY[id]) return hersheyFont(HERSHEY[id]);
  const url = OUTLINE[id];
  if (!url) throw new Error(`Unknown font ${id}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the font (${res.status})`);
  return outlineFont(parse(await res.arrayBuffer()));
}

/** A font file the user picked: TrueType, OpenType or WOFF. */
export function fontFromBytes(bytes: ArrayBuffer): TextFont {
  return outlineFont(parse(bytes));
}
