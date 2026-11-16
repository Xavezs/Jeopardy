import { useEffect, useState } from "react";
import { getSfxVolume, setSfxVolume, subscribeSfxVolume } from "../lib/sfx";

export default function SfxVolumeControl({
  className = "bgm-fs-volume-row",
  labelClassName = "bgm-fs-volume-label",
  sliderClassName = "bgm-fs-volume-slider",
}) {
  const [volume, setVolume] = useState(getSfxVolume);

  useEffect(() => subscribeSfxVolume(setVolume), []);

  return (
    <div className={className}>
      <span className={labelClassName} title="Sound effects volume — only affects your own device">
        Sound Effects
      </span>
      <input
        className={sliderClassName}
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={volume}
        onChange={(event) => setSfxVolume(event.target.value)}
        aria-label="Sound effects volume"
        title={`Sound effects volume: ${Math.round(volume * 100)}% (only affects your own device)`}
      />
    </div>
  );
}
