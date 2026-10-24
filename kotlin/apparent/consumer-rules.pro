# Apparent: the public API is called by name from apps; keep it readable in stack traces too.
-keep class fyi.apparent.Apparent { public *; }
-keep class fyi.apparent.ApparentConfig { *; }
# The install-referrer library is optional.
-dontwarn com.android.installreferrer.**
