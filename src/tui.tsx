/**
 * opencode-quota — terminal half.
 *
 * Registers `/quota`, asks the server half for a report, and shows it in a
 * dialog. Keeping the command here is what makes it a real slash command rather
 * than a prompt that would spend tokens on a model turn.
 */

import { Plugin } from "@opencode/plugin/tui";
import { QuotaRpc, parseQuotaReport } from "./rpc.ts";
import { formatReport } from "./format.ts";

export default Plugin.define({
  id: "opencode-quota.tui",
  setup(context) {
    const quota = context.client.rpc(QuotaRpc);

    const show = async () => {
      let report: string;
      try {
        const result = await quota.report({});
        report = formatReport(parseQuotaReport(result));
      } catch (error) {
        report = `Could not read quota: ${error instanceof Error ? error.message : String(error)}`;
      }

      context.ui.dialog.set({ size: "large", centered: true });
      context.ui.dialog.show(
        () => (
          <box flexDirection="column" padding={1}>
            <text fg={context.theme.text.base}>Quota</text>
            <text fg={context.theme.text.muted}>{report}</text>
          </box>
        ),
        () => context.ui.dialog.clear(),
      );
    };

    // The keymap layer must be created from inside the app's render tree: the
    // host keeps its keymap state in a reactive context, and reaching for it
    // during setup runs outside that tree and fails with "Keymap.Provider is
    // missing". Claiming an `app` slot places this render inside the tree, and
    // the returned disposer removes the slot when the plugin unloads.
    return context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "opencode-quota.show",
              title: "Quota",
              description: "Show remaining quota for connected accounts",
              group: "opencode-quota",
              palette: true,
              slash: { name: "quota", aliases: ["quota-report"] },
              run: show,
            },
          ],
        }));
        return null;
      },
    });
  },
});
