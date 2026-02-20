With our funnel architecture, all tcp connections from the client side are sent through a single funnel (ssh connection) and expanded to respective listeners/servers on the host side. But how do we orchestrate this?

- Assume all the ports have been allocated (decided upon) on both the host side and the client side
- The Proxy server on the host side knows which TCP connections it has to monitor from the gdb-server
- The Proxy client side knows that there may be a set of clients at some point will try to connect.
- The gdb-server may take a while to listen to various ports
- THe most critical client is the gdb. It is special and this is how it is handled

- Normally (when the host is same as client), we wait for a specific signal (usually a regex match on stdout). Once we see this, we know the gdb-server is ready for business and we tell gdb to connect. Any sooner, gdb errors out -- there are no retries
- We have to do the same thing but instead of on the client side, it occurs on the host side. Steps
  - Trigger is the regex on the gdb-server stdout/stderr
  - We start listening on the corresponding port on client side
  - We notify the DA/client-side-proxy tht the port is ready (wish we can avoid this but sequencing has to work)
  - DA notifies gdb that the server is ready

That was the easy part. We have other clients. SWO and RTT style. It is possible that such clients belong to us or someone else. Regardless, they should already be polling. Problem is that we can't begin listening
on the client side until the gdb-server itself is known to be listenting. But we have no idea when that will be. There is no good non-invasive way for us to monitor the server beginning to listen.

Once we know that the server is listening, we can being listening on the client side and everything will work fine.

So, how do we non-invasively check if the server is listenting?

- We can try to connect ourselves on the host side proxy. But this is invasive and the server may only allow one connection
- We can try to bind on the same port but this will cause a failure when the gdb-server tries to create one
- We can do it the super slow way. Use OS specific ways to see if a listen is happening on the port. lsof, netstat, etc. We can easily see a delay of an entire second.
