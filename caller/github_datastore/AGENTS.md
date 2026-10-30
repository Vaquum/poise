Build a system that does exactly what it has to do, what the human says it has to do, and nothing else. 

Do not do anything ornamental. Do not add any other kind of test than fail hard and loud test. 

Never use any swallows, fallbacks, or anything that deprive us from the most direct signal pertaining to how the system we are building works.

The fact that we capture everything that user is directly connected with, was it mention, review, comment, assignement, whatever where there is direct connection between the issue and the user, the fact that we capture it in the initial build and every sync has to be truly guaranteed, nothing goes missing, and nothing is added. That is the foundation. Now you can take that and then claim you did it because you used certain APIs and they did, but that is not the test, the test is if it's all or not. If anything was added or not. The question is "actually, in the world of github, is there something this user is directly connected with that I don't have here" and "what I have here, does some of it lack direct connection with this user". Those are the two questions to always ask every step of the way, every task, this is the question. Can I trust this foundation, because if not, then everything downstream is meaningless. 

github auth is available on local through gh. The datastore reads as the account whose token it is given, and builds the involvement of the user it is told to.

GitHub GraphQL is the source of truth, and everything else is projection from that. So if you want to know how many, you have to project from graphql to get the answer.

Writes and reads are totally separate. The event log is org level, and everything else is projected from that. 