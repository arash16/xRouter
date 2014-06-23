xRouter
=======

An advanced router implementation for Durandal, Fixing issues for hierarchical activators, and some other enhancements (most notably Route-Authorization)

Since router implementation of Durandal has not designed to be hierarchical, even-though it supports notion of child-routers, they're simple in nature and activation life-cycle calls are not called correctly for deep pages.
I have re-designed almost everything in old router to fix hierarchical activations (plus adding other enhancements), and it would break many dependent projects on original router.


*In progress of factoring out dependencies on durandal's internals*
