import Page from "./page";

// A shared path such as /bus/kmb/… is not a built page. Static hosts serve
// this file for it and the map reads the path.
export default function NotFound() {
  return <Page />;
}
