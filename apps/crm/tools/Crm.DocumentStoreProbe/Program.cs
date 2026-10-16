using System.Text;
using System.Text.Json;
using Crm.Infrastructure.Documents;

// Test-only subprocess; stdin is the deterministic barrier, stdout contains synthetic object results only.
var root = args[0];
var key = args[1];
var writer = args[2];
var pause = args[3];
var store = new FileSystemDocumentStore(root, createRoot: false, stage =>
{
    if (stage.ToString() == pause)
    {
        Console.WriteLine(stage);
        Console.Out.Flush();
        Console.ReadLine();
    }
});
Console.WriteLine("Ready");
Console.Out.Flush();
Console.ReadLine();
var result = await store.PutAsync(key, Encoding.UTF8.GetBytes(writer + new string('x', 256 * 1024)), "application/pdf", CancellationToken.None);
Console.WriteLine(JsonSerializer.Serialize(result));
