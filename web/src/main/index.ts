// The main-world content script: loaded into every frame at document_start by the manifest's world MAIN entry.
import { installCapture } from "./console";
import { installNetworkCapture } from "./network";

installCapture(window);
installNetworkCapture(window);
