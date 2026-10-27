Build everything the most simplest, most basic, least ornamented version possible to meet the capability requirement. Every step of the way. Do not allow any bloat or ornamentation creep in.

We are building a fundamental/atomic agent interface that allows calling four different agents to do specific pre-determined behaviors. We first make the basic functionality of being able to call the four different models through one endpoint robust, and then we start adding the behaviors.

Never make decisions by yourself, always interrupt when in the slightest doubt and ask the operator.

You must never allow any of the endpoints to use anything except our internal interface commands, never bare python, bash, or anything else. Just the interface calls. If this becomes a blocker, interrupt immediately and let me know.

When I ask you to add new capability, you must always either a) compose it from our own internal calls, b) ask me permission to extend internal calls. 

Never make external calls to compose new interface capabilities unless given explicit permission to do so.