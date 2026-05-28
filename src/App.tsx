// Root ink component for the TBLang TUI skeleton.
import { Box, Text, useApp, useInput } from "ink";

export default function App() {
  const { exit } = useApp();

  // Exit on q or Ctrl+C.
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Text>TBLang</Text>
      <Text dimColor>Press q to quit</Text>
    </Box>
  );
}
