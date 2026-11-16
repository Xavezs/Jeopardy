import fahhhUrl from "../assets/fahhh.mp3";
import vineBoomUrl from "../assets/vine-boom.mp3";

const SOUND_ASSETS = new Map([
  ["fahhh.mp3", fahhhUrl],
  ["vine-boom.mp3", vineBoomUrl],
]);

export function getBuzzSoundUrl(item) {
  const asset = item?.data?.asset;
  if (typeof asset !== "string") return null;
  return SOUND_ASSETS.get(asset.toLowerCase()) || null;
}
