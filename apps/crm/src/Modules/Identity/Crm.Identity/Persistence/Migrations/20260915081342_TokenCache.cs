using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Identity.Persistence.Migrations
{
    /// <summary>
    /// Table for the SQL Server distributed cache used as the MSAL token cache (Microsoft.Extensions.Caching.SqlServer schema).
    /// </summary>
    public partial class TokenCache : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                CREATE TABLE [identity].[TokenCache] (
                    [Id] nvarchar(449) COLLATE SQL_Latin1_General_CP1_CS_AS NOT NULL,
                    [Value] varbinary(max) NOT NULL,
                    [ExpiresAtTime] datetimeoffset NOT NULL,
                    [SlidingExpirationInSeconds] bigint NULL,
                    [AbsoluteExpiration] datetimeoffset NULL,
                    CONSTRAINT [PK_TokenCache] PRIMARY KEY ([Id])
                );
                CREATE NONCLUSTERED INDEX [IX_TokenCache_ExpiresAtTime] ON [identity].[TokenCache] ([ExpiresAtTime]);
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP TABLE [identity].[TokenCache];");
        }
    }
}
