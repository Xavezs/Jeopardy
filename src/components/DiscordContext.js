import { createContext, useContext } from "react";

export const DiscordContext = createContext(null);
export const useDiscordAuth = () => useContext(DiscordContext);
