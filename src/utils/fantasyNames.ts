/**
 * Procedural fantasy names for realms and points of interest.
 */
import { FastRandom } from '../core/noise';
import type { POICategory } from '../types/map';

const REALM_PREFIXES = [
  'Aethel', 'Val', 'Ald', 'Eld', 'Frost', 'Iron', 'Shadow', 'Sun', 'Moon', 'Storm',
  'Silver', 'Gold', 'Dusk', 'Dawn', 'Dragon', 'Raven', 'Oak', 'High', 'Deep', 'Ever',
  'Myth', 'Star', 'Grim', 'Bright', 'Ashen', 'Rune', 'Ember', 'Winter', 'Verdant', 'Cloud'
];

const REALM_SUFFIXES = [
  'gard', 'heim', 'dor', 'ria', 'land', 'vale', 'reach', 'fell', 'hold', 'mark',
  'haven', 'crest', 'wood', 'dell', 'shire', 'forge', 'spire', 'mere', 'gate', 'peak',
  'keep', 'shore', 'hollow', 'moor', 'bastion', 'bay', 'crag', 'sanctum', 'throne', 'deep'
];

const ELVEN_PARTS_1 = ['Sil', 'Loth', 'Cael', 'Gal', 'Thran', 'Elen', 'Aer', 'Fael', 'Nim', 'Laur', 'Ithil', 'Arwen'];
const ELVEN_PARTS_2 = ['anar', 'idor', 'lorien', 'dril', 'rion', 'wen', 'gorn', 'thas', 'vallen', 'rond', 'iel'];

const DWARVEN_PARTS_1 = ['Khaz', 'Thor', 'Dur', 'Baruk', 'Grim', 'Bal', 'Grum', 'Krag', 'Iron', 'Stone', 'Kaz'];
const DWARVEN_PARTS_2 = ['adum', 'gund', 'drak', 'fang', 'hold', 'delve', 'forge', 'peak', 'mor', 'khil'];

const TITLE_EPITHETS = [
  'The Ancient Realm', 'The Crown of Winds', 'The Sundered Lands', 'The Eternal Coast',
  'The Forgotten Marches', 'The Dragon Dominion', 'The Sylvan Expanse', 'The Frostpeak Dominion',
  'The Radiant Sovereignty', 'The Iron Confederacy', 'The Shrouded Reaches', 'The Whispering Wilds'
];

export function generateRealmTitle(seed: number): { title: string; subtitle: string; author: string } {
  const rng = new FastRandom(seed);
  const p1 = REALM_PREFIXES[Math.floor(rng.next() * REALM_PREFIXES.length)];
  const p2 = REALM_SUFFIXES[Math.floor(rng.next() * REALM_SUFFIXES.length)];
  const title = `The Realm of ${p1}${p2}`;
  const subtitle = TITLE_EPITHETS[Math.floor(rng.next() * TITLE_EPITHETS.length)];
  const author = `Cartographer ${['Aldous Vance', 'Elarion Moonwhisper', 'Master Thorin Stonebrow', 'Arch-Mage Justinian', 'Sylas of Oakhaven'][Math.floor(rng.next() * 5)]}`;

  return { title, subtitle, author };
}

export function generatePOIName(category: POICategory, seed: number): string {
  const rng = new FastRandom(seed);

  // Use Elven, Dwarven, or Standard syllables based on category
  let p1: string;
  let p2: string;

  if (category === 'shrine' || category === 'tower') {
    p1 = ELVEN_PARTS_1[Math.floor(rng.next() * ELVEN_PARTS_1.length)];
    p2 = ELVEN_PARTS_2[Math.floor(rng.next() * ELVEN_PARTS_2.length)];
  } else if (category === 'mine' || category === 'cave') {
    p1 = DWARVEN_PARTS_1[Math.floor(rng.next() * DWARVEN_PARTS_1.length)];
    p2 = DWARVEN_PARTS_2[Math.floor(rng.next() * DWARVEN_PARTS_2.length)];
  } else {
    p1 = REALM_PREFIXES[Math.floor(rng.next() * REALM_PREFIXES.length)];
    p2 = REALM_SUFFIXES[Math.floor(rng.next() * REALM_SUFFIXES.length)];
  }

  switch (category) {
    case 'capital':
      return `${p1}${p2} Prime`;
    case 'castle':
      return `Fortress of ${p1}${p2}`;
    case 'town':
      return `${p1}${p2}`;
    case 'village':
      return `${p1}'s Rest`;
    case 'port':
      return `Port ${p1}${p2}`;
    case 'tower':
      return `Spire of ${p1}${p2}`;
    case 'ruins':
      return `Ruins of ${p1}${p2}`;
    case 'dungeon':
      return `The Depths of ${p1}`;
    case 'cave':
      return `${p1} Grotto`;
    case 'mine':
      return `${p1} Mines`;
    case 'dragon':
      return `${p1} Wyrm's Roost`;
    case 'shrine':
      return `Shrine of ${p1}${p2}`;
    case 'mountain_label':
      return `${p1} Mountains`;
    case 'sea_label':
      return `Sea of ${p1}`;
    case 'region_label':
      return `The ${p1} Wilds`;
    default:
      return `${p1}${p2}`;
  }
}
