# @context/lab

The Tex Lab's code: the logic shared by the Lab page, the control plane and the gateway's `tex_dev` tool and test
chats (`src/`), the gateway's Lab code (`gateway/`: test chats and `tex_dev`; what it takes from the gateway is in
`gateway/fromGateway/`), and the Lab page (`app/`, served by the app's `/lab` route; what it takes from the app is in
`app/fromApp/`). It depends on Tex (its config and graph), never the reverse. Apps keep thin files only where a deploy tool
looks (Convex functions, Expo routes, Worker entries). See
[`docs/decisions/texting-assistant/lab-package.md`](../../docs/decisions/texting-assistant/lab-package.md).
