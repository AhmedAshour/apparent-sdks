/// Apparent for Flutter: product events for the Apparent dashboard (apparent.fyi).
///
///     await Apparent.start(app: 'einb', key: '<write key>', disabled: kDebugMode);
///     Apparent.track('paywall_view', {'source': 'onboarding'});
library;

export 'src/client.dart' show ApparentClient, ApparentConfig, ApparentDevice, ApparentAppState, ApparentEvent, sdkVersion, errorFields, cleanDeepLink;
export 'src/flutter_binding.dart' show Apparent, ApparentNavigatorObserver, defaultScreenName, readDevice;
export 'src/storage.dart' show ApparentStorage, MemoryStorage, FileStorage;
