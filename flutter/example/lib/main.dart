import 'package:apparent/apparent.dart';
import 'package:flutter/material.dart';

/// The example talks to tool/fake_intake.mjs on this computer, never to Apparent.
const intake = String.fromEnvironment('APPARENT_URL', defaultValue: 'http://127.0.0.1:8787');

void main() {
  // No await needed: events tracked before it has read the phone's saved state are kept.
  Apparent.start(app: 'example', key: 'example-key', apiUrl: intake, debug: true);
  runApp(const ExampleApp());
}

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Apparent example',
      navigatorObservers: [ApparentNavigatorObserver()],
      routes: {
        '/': (_) => const HomeScreen(),
        '/settings': (_) => const SettingsScreen(),
      },
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  String? user;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Apparent example')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Install id: ${Apparent.anonymousId ?? '…'}\nUser: ${user ?? 'signed out'}\nSending to $intake'),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: () => Apparent.track('paywall_view', {'source': 'example'}),
            child: const Text('Track paywall_view'),
          ),
          OutlinedButton(
            onPressed: () => Navigator.of(context).pushNamed('/settings'),
            child: const Text('Open settings (screen_view)'),
          ),
          OutlinedButton(
            onPressed: () {
              setState(() => user = user == null ? 'user-42' : null);
              user == null ? Apparent.logout() : Apparent.identify(user);
            },
            child: Text(user == null ? 'Sign in as user-42' : 'Sign out (new install id)'),
          ),
          OutlinedButton(
            onPressed: () => throw StateError('Example error from a button'),
            child: const Text('Throw an error'),
          ),
          OutlinedButton(
            onPressed: () => Apparent.flush(),
            child: const Text('Send now'),
          ),
        ],
      ),
    );
  }
}

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: SwitchListTile(
        title: const Text('Share usage data'),
        value: !Apparent.isOptedOut,
        onChanged: (on) {
          on ? Apparent.optIn() : Apparent.optOut();
          (context as Element).markNeedsBuild();
        },
      ),
    );
  }
}
