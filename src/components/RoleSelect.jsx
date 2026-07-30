import React, { useState } from "react";

export default function RoleSelect({ onSelectHost, onSelectPlayer, defaultTeamName = "" }) {
  const [inputCode, setInputCode] = useState("");
  const [teamName, setTeamName] = useState(defaultTeamName);

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-slate-950 text-white p-6">
      <div className="bg-slate-900 border border-slate-800 p-8 rounded-2xl shadow-2xl w-full max-w-md flex flex-col gap-6">
        <div className="text-center">
          <h1 className="text-3xl font-black text-yellow-400 tracking-wide mb-2">JEOPARDY!</h1>
          <p className="text-slate-400 text-sm">Choose how you want to enter this session</p>
        </div>

        {/* Host Option */}
        <div className="flex flex-col gap-2">
          <button
            onClick={onSelectHost}
            className="w-full bg-yellow-500 hover:bg-yellow-400 text-slate-950 font-bold py-3.5 px-4 rounded-xl transition shadow-lg text-center"
          >
            Host / Manage Board
          </button>
          <span className="text-xs text-slate-500 text-center">Create or edit questions and run the game show.</span>
        </div>

        <div className="flex items-center gap-4 my-2">
          <div className="flex-1 h-px bg-slate-800" />
          <span className="text-xs text-slate-600 uppercase font-bold">OR</span>
          <div className="flex-1 h-px bg-slate-800" />
        </div>

        {/* Player Option */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmedCode = inputCode.trim();
            const trimmedName = teamName.trim();
            if (trimmedCode && trimmedName) onSelectPlayer(trimmedCode.toUpperCase(), trimmedName);
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Your Team Name</label>
            <input
              type="text"
              placeholder={defaultTeamName || "e.g. The Buzzer Beaters"}
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              className="bg-slate-950 border border-slate-800 p-3 rounded-xl text-white text-center focus:outline-none focus:border-yellow-500 transition"
              maxLength={24}
            />
            <span className="text-[11px] text-slate-500 text-center">
              Joining an existing team name adds you to it — new names create a new team.
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Join a Room</label>
            <input
              type="text"
              placeholder="Enter Room Code (e.g. 7FE4SE)"
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value)}
              className="bg-slate-950 border border-slate-800 p-3 rounded-xl text-white uppercase tracking-widest text-center placeholder:normal-case placeholder:tracking-normal focus:outline-none focus:border-yellow-500 transition"
              maxLength={8}
            />
          </div>
          <button
            type="submit"
            disabled={!inputCode.trim() || !teamName.trim()}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 text-white font-bold py-3.5 px-4 rounded-xl transition shadow-lg"
          >
            Join as Player
          </button>
        </form>
      </div>
    </div>
  );
}