# Apparent Flutter example

Sends to a fake intake on this computer, never to Apparent:

```bash
node ../tool/fake_intake.mjs                      # prints every batch, port 8787
flutter run                                       # iOS Simulator; Android emulator: --dart-define=APPARENT_URL=http://10.0.2.2:8787
```
